import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";

/**
 * The real connection behind a request, which a Next.js route handler cannot otherwise see.
 *
 * Next.js hands route handlers a web Request with no socket, and fills X-Forwarded-For/-Proto/-Host
 * from the socket only when the client sent none (base-server.js, `??=`). So without help, a client
 * talking straight to the app port can claim any address or "https". The setup wizard needs the
 * truth to (a) believe forwarded headers only from a trusted proxy, (b) key the attempt limiter by
 * an address the client cannot choose, and (c) allow plain HTTP only through a real SSH tunnel.
 *
 * In setup mode, boot tasks install a hook on the Node HTTP server's "request" event, which runs
 * before Next.js touches the request. It records, from the socket itself:
 *
 * - `peer`: the immediate peer's address (a proxy, a tunnel's sshd, or the browser);
 * - `bound`: the address the server is listening on (server.address(); 0.0.0.0/:: = every interface);
 * - `tls`: whether the socket itself is TLS;
 * - `forwarded`: whether the client's request carried any forwarding header.
 *
 * It is passed in a request header whose name holds a random per-process nonce, so a client cannot
 * forge it, and any header that looks like it is removed first. Next.js runs the HTTP server and the
 * instrumentation hook in one process (next/dist/server/lib/start-server.js), which is what makes
 * this possible; if the hook is missing, readers get null and the setup guards fail closed.
 */

export interface PeerInfo {
  peer: string | null;
  bound: string | null;
  tls: boolean;
  forwarded: boolean;
}

const HEADER_PREFIX = "x-polynovea-peer-";
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port", "x-real-ip"];

interface Holder {
  header: string;
  installed: boolean;
  originals?: Array<{ proto: { emit: (...args: unknown[]) => boolean }; emit: (...args: unknown[]) => boolean }>;
}

const KEY = Symbol.for("polynovea.setup.peerStamp");
const store = globalThis as typeof globalThis & { [KEY]?: Holder };

function holder(): Holder {
  return (store[KEY] ??= { header: `${HEADER_PREFIX}${randomBytes(12).toString("hex")}`, installed: false });
}

interface StampableRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: Socket | null;
}

/** Writes the stamp onto a raw Node request. Exported for tests; the server hook calls it. */
export function stampRequest(request: StampableRequest, server: { address(): AddressInfo | string | null } | null): void {
  for (const name of Object.keys(request.headers)) {
    if (name.toLowerCase().startsWith(HEADER_PREFIX)) delete request.headers[name];
  }
  let bound: string | null = null;
  try {
    const address = server?.address();
    bound = address && typeof address === "object" ? address.address : null;
  } catch {
    bound = null;
  }
  const socket = request.socket ?? null;
  const info: PeerInfo = {
    peer: socket?.remoteAddress ?? null,
    bound,
    tls: Boolean((socket as (Socket & { encrypted?: boolean }) | null)?.encrypted),
    forwarded: FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined),
  };
  // Not remote property injection: the key is a server-generated per-process nonce (holder()), never
  // client input, and every client header with this prefix was deleted above.
  // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection
  request.headers[holder().header] = JSON.stringify(info);
}

/** Installs the hook once per process. Returns true when it is active. */
export function installPeerStamp(): boolean {
  const h = holder();
  if (h.installed) return true;
  h.originals = [];
  for (const proto of new Set([http.Server.prototype, https.Server.prototype]) as Set<{ emit: (...args: unknown[]) => boolean }>) {
    const original = proto.emit;
    h.originals.push({ proto, emit: original });
    proto.emit = function stampedEmit(this: { address(): AddressInfo | string | null }, event: unknown, ...args: unknown[]) {
      if (event === "request" && args[0] && typeof args[0] === "object") {
        try {
          stampRequest(args[0] as StampableRequest, this);
        } catch {
          // A request without a stamp is refused by the setup guards; never break the server here.
        }
      }
      return original.call(this, event, ...args);
    };
  }
  h.installed = true;
  return true;
}

/** The stamp for this request, or null when there is none (hook not installed, or not a real request). */
export function readPeerInfo(headers: Headers): PeerInfo | null {
  const raw = headers.get(holder().header);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PeerInfo>;
    return {
      peer: typeof value.peer === "string" ? value.peer : null,
      bound: typeof value.bound === "string" ? value.bound : null,
      tls: value.tls === true,
      forwarded: value.forwarded === true,
    };
  } catch {
    return null;
  }
}

/** Tests only: the header entry a stamped request would carry. */
export function peerStampEntryForTests(info: PeerInfo): [string, string] {
  return [holder().header, JSON.stringify(info)];
}

/** Tests only: undo the hook. */
export function uninstallPeerStampForTests(): void {
  const h = holder();
  for (const { proto, emit } of h.originals ?? []) proto.emit = emit;
  h.originals = [];
  h.installed = false;
}
