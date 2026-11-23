import { BlockList, isIP } from "node:net";
import { parseTrustedProxies } from "@/lib/auth/settings";
import { readPeerInfo, type PeerInfo } from "./peerStamp";

/**
 * Checks every setup POST must pass before anything else runs, plus the headers every setup
 * response carries. Shared by all wizard steps (setup-code, db-step, owner-step).
 *
 * - Transport: HTTPS, as reported by a trusted proxy (X-Forwarded-Proto) or by the socket itself;
 *   or plain HTTP through a real SSH tunnel (see setupTransport). Plain HTTP to a public address
 *   would send the setup code in the clear.
 * - Origin must be this request's own origin and, when set, POLYNOVEA_PUBLIC_URL's.
 * - `code` in the query string is refused: URLs end up in proxy and access logs.
 *
 * Everything starts from the real connection (peerStamp.ts), never from what the client says:
 * X-Forwarded-For/-Proto/-Host are believed only when the immediate peer is in
 * POLYNOVEA_TRUSTED_PROXIES, and then X-Forwarded-For is walked right to left past the trusted
 * proxies (the built-in auth's rule). Otherwise the client is the socket's peer. Without the stamp
 * nothing is believed and every check fails closed.
 *
 * Failures are logged with the reason; the response is one generic message.
 */

type Env = Record<string, string | undefined>;
export type SetupTransport = "https" | "loopback";
export interface SetupRequestLike {
  headers: Headers;
  url: string;
  method?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const SETUP_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
});

/** One message for every guard failure, so the response never says which check tripped. */
export const SETUP_GUARD_MESSAGE = "This setup request was refused. Open the setup page over HTTPS or through an SSH tunnel, and submit the form from there.";

function trustedProxyList(env: Env): BlockList | null {
  const entries = parseTrustedProxies(env.POLYNOVEA_TRUSTED_PROXIES);
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    const normalised = family === "ipv4" ? address : address.toLowerCase();
    if (prefix === undefined) list.addAddress(normalised, family);
    else list.addSubnet(normalised, Number(prefix), family);
  }
  return list;
}

/** "1.2.3.4", "[::1]:5000", "1.2.3.4:5000", "::ffff:1.2.3.4" → a bare address, or null. */
export function cleanAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  value = value.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  return isIP(value) ? value.toLowerCase() : null;
}

function isTrusted(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** The rightmost value of a header proxies may append to ("a, b, c" → "c"). */
function lastValue(headers: Headers, name: string): string | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function isLoopbackAddress(address: string | null): boolean {
  const clean = address ? cleanAddress(address) : null;
  if (!clean) return false;
  if (isIP(clean) === 4) return clean.startsWith("127.");
  return clean === "::1";
}

function hostIsLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(name) || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** The real connection and whether its peer is a proxy we trust; null when unknown (fail closed). */
interface Connection {
  info: PeerInfo;
  peer: string | null;
  viaTrustedProxy: boolean;
}

function connection(headers: Headers, env: Env): Connection | null {
  const info = readPeerInfo(headers);
  if (!info) return null;
  const peer = info.peer ? cleanAddress(info.peer) : null;
  const trusted = trustedProxyList(env);
  return { info, peer, viaTrustedProxy: Boolean(peer && trusted && isTrusted(trusted, peer)) };
}

/**
 * The client's address: the socket's peer, or, when that peer is a trusted proxy, the first
 * untrusted address walking X-Forwarded-For right to left. Null when the connection is unknown.
 */
export function setupClientAddress(headers: Headers, env: Env = process.env): string | null {
  const conn = connection(headers, env);
  if (!conn) return null;
  if (!conn.viaTrustedProxy) return conn.peer;
  const trusted = trustedProxyList(env)!;
  const chain = (headers.get("x-forwarded-for") ?? "").split(",").map(cleanAddress).filter((a): a is string => a !== null);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!isTrusted(trusted, chain[i])) return chain[i];
  }
  // Every hop is a proxy we trust (a request from the proxy host itself): the first hop is the client.
  return chain[0] ?? conn.peer;
}

function isHttps(headers: Headers, conn: Connection): boolean {
  if (conn.info.tls) return true;
  return conn.viaTrustedProxy && lastValue(headers, "x-forwarded-proto")?.toLowerCase() === "https";
}

/** Host the browser asked for: X-Forwarded-Host from a trusted proxy, else Host. */
function requestHost(headers: Headers, conn: Connection): string | null {
  const forwarded = conn.viaTrustedProxy ? lastValue(headers, "x-forwarded-host") : null;
  return (forwarded ?? headers.get("host"))?.trim().toLowerCase() || null;
}

/**
 * How this request reached the CMS, if the setup code may travel over it. Null otherwise.
 *
 * - "https": the socket is TLS, or a trusted proxy says the browser used HTTPS.
 * - "loopback" (an SSH tunnel), only when all of these hold: the server listens on 127.0.0.1 or ::1
 *   only (not 0.0.0.0/::), the socket's peer is loopback, the request carries no forwarding header
 *   (so no local proxy is relaying someone else), and the browser asked for a loopback host.
 */
export function setupTransport(headers: Headers, env: Env = process.env): SetupTransport | null {
  const conn = connection(headers, env);
  if (!conn) return null;
  if (isHttps(headers, conn)) return "https";
  const host = requestHost(headers, conn);
  const boundToLoopback = isLoopbackAddress(conn.info.bound);
  if (boundToLoopback && !conn.info.forwarded && isLoopbackAddress(conn.peer) && host && hostIsLoopback(host)) return "loopback";
  return null;
}

/** This request's own origin as the browser sees it, or null when unknown. */
export function setupOwnOrigin(headers: Headers, env: Env = process.env): string | null {
  const conn = connection(headers, env);
  if (!conn) return null;
  const host = requestHost(headers, conn);
  if (!host) return null;
  return `${isHttps(headers, conn) ? "https" : "http"}://${host}`;
}

function publicOrigin(env: Env): string | null {
  const raw = env.POLYNOVEA_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin.toLowerCase();
  } catch {
    return "invalid";
  }
}

/** True when any query parameter is named `code`, in any case. */
export function hasCodeInQuery(url: string): boolean {
  try {
    for (const key of new URL(url, "http://setup.invalid").searchParams.keys()) {
      if (key.trim().toLowerCase() === "code") return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Null when a setup POST may proceed; otherwise the reason, for the server log only. */
export function setupRequestProblem(request: SetupRequestLike, env: Env = process.env): string | null {
  if (hasCodeInQuery(request.url)) return "setup code in the query string";
  if ((request.method ?? "POST").toUpperCase() !== "POST") return "not a POST";
  if (!readPeerInfo(request.headers)) return "connection details unavailable (the peer stamp is not installed; it is set up by boot tasks in setup mode)";
  if (!setupTransport(request.headers, env)) return "neither HTTPS nor an SSH tunnel to a loopback-only server";
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return "cross-site request";
  const origin = request.headers.get("origin")?.trim().toLowerCase();
  if (!origin || origin === "null") return "no Origin header";
  if (origin !== setupOwnOrigin(request.headers, env)) return "Origin does not match the request's own origin";
  const configured = publicOrigin(env);
  if (configured && origin !== configured) return "Origin does not match POLYNOVEA_PUBLIC_URL";
  return null;
}

/** Adds the setup response headers (no caching, no referrer, no framing) and returns the response. */
export function withSetupHeaders<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(SETUP_RESPONSE_HEADERS)) response.headers.set(name, value);
  return response;
}

/** The JSON envelope the rest of the API uses, with the setup headers. */
export function setupJson(status: number, body: { data?: unknown; error?: string | null; code?: string }, headers: Record<string, string> = {}): Response {
  const payload = { success: status < 400, data: body.data ?? null, error: body.error ?? null, ...(body.code ? { code: body.code } : {}), timestamp: new Date().toISOString() };
  return withSetupHeaders(Response.json(payload, { status, headers }));
}

export function setupGuardResponse(): Response {
  return setupJson(403, { error: SETUP_GUARD_MESSAGE, code: "SETUP_REQUEST_REFUSED" });
}

/**
 * Runs every guard. Returns null to carry on, or the refusal to send (the reason goes to the log).
 * Call it first in every setup POST handler.
 */
export function guardSetupRequest(request: SetupRequestLike, env: Env = process.env, logger: Pick<Console, "warn"> = console): Response | null {
  const problem = setupRequestProblem(request, env);
  if (!problem) return null;
  logger.warn(`[setup] Refused a setup request: ${problem}.`);
  return setupGuardResponse();
}
