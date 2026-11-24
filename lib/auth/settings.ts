/**
 * Which identity provider the CMS uses, chosen by AUTH_PROVIDER:
 *
 *   AUTH_PROVIDER=supabase   Supabase GoTrue (the default during phase 1, and the rollback path)
 *   AUTH_PROVIDER=builtin    the built-in auth (Better Auth on our own PostgreSQL)
 *
 * The browser bundle needs the same choice, so NEXT_PUBLIC_AUTH_PROVIDER must match; the build reads
 * it at build time. An unknown value is a configuration error and throws rather than silently
 * picking a provider.
 */
export const AUTH_PROVIDERS = ["supabase", "builtin"] as const;
export type AuthProviderName = (typeof AUTH_PROVIDERS)[number];

export function parseAuthProvider(raw: string | undefined): AuthProviderName {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "supabase";
  if ((AUTH_PROVIDERS as readonly string[]).includes(value)) return value as AuthProviderName;
  throw new Error(`AUTH_PROVIDER must be one of ${AUTH_PROVIDERS.join(", ")}`);
}

/** Server side: read on every call, so tests can switch it. */
export function serverAuthProvider(): AuthProviderName {
  return parseAuthProvider(process.env.AUTH_PROVIDER);
}

/** Browser side: inlined at build time by Next.js. */
export function browserAuthProvider(): AuthProviderName {
  return parseAuthProvider(process.env.NEXT_PUBLIC_AUTH_PROVIDER);
}

const IP_OR_CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)(?:\/\d{1,3})?$/i;

/** POLYNOVEA_TRUSTED_PROXIES: comma-separated addresses or CIDR ranges. Throws on anything else. */
export function parseTrustedProxies(raw: string | undefined): string[] {
  const values = (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const value of values) {
    if (!IP_OR_CIDR.test(value)) throw new Error(`POLYNOVEA_TRUSTED_PROXIES has an entry that is not an address or CIDR range: ${value}`);
  }
  return values;
}

/**
 * How the built-in auth learns a client's address, for its sign-in rate limits and session records:
 *
 *   "proxied"  from X-Forwarded-For, walked past POLYNOVEA_TRUSTED_PROXIES (a reverse proxy in front);
 *   "tunnel"   never from a client-supplied header: every sign-in shares one rate-limit bucket and no
 *              client address is recorded. Only for the SSH-tunnel route: the CMS is bound to loopback
 *              (HOSTNAME 127.0.0.1 or ::1, which the server listens on) AND POLYNOVEA_PUBLIC_URL is
 *              http:// on localhost, 127.0.0.1 or [::1]. Only people with SSH to the server can reach
 *              it, so a per-address limit adds nothing there, and a forged header changes nothing.
 *
 * The Caddy/domain route also binds the CMS to loopback, but its address is https on a real host:
 * it is "proxied" and must list its proxy.
 */
export type ClientAddressMode = "proxied" | "tunnel";

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function clientAddressMode(env: Record<string, string | undefined> = process.env): ClientAddressMode {
  if (parseTrustedProxies(env.POLYNOVEA_TRUSTED_PROXIES).length > 0) return "proxied";
  if (!LOOPBACK_BINDS.has((env.HOSTNAME ?? "").trim())) return "proxied";
  let url: URL;
  try {
    url = new URL((env.POLYNOVEA_PUBLIC_URL ?? "").trim());
  } catch {
    return "proxied";
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) ? "tunnel" : "proxied";
}

/**
 * Checked when the server starts (instrumentation.ts), so a typo or mismatch stops the deploy.
 * Returns the built-in auth's client-address mode (null for another provider).
 */
export function assertAuthSettings(): ClientAddressMode | null {
  const server = serverAuthProvider();
  const browser = parseAuthProvider(process.env.NEXT_PUBLIC_AUTH_PROVIDER);
  if (server !== browser) {
    throw new Error(`AUTH_PROVIDER (${server}) and NEXT_PUBLIC_AUTH_PROVIDER (${browser}) must match`);
  }
  if (server === "builtin") {
    if ((process.env.POLYNOVEA_AUTH_SECRET ?? "").length < 32) throw new Error("POLYNOVEA_AUTH_SECRET must be at least 32 characters for the built-in auth");
    if (!process.env.POLYNOVEA_PUBLIC_URL) throw new Error("POLYNOVEA_PUBLIC_URL is required for the built-in auth");
    const proxies = parseTrustedProxies(process.env.POLYNOVEA_TRUSTED_PROXIES);
    const mode = clientAddressMode(process.env);
    // Without the proxy list, a client could choose its own rate-limit bucket with X-Forwarded-For,
    // except in tunnel mode, where no client header is read at all.
    if (process.env.NODE_ENV === "production" && proxies.length === 0 && mode !== "tunnel") {
      throw new Error("POLYNOVEA_TRUSTED_PROXIES must list the reverse proxies in front of the app for the built-in auth (an SSH-tunnel install needs none: HOSTNAME=127.0.0.1 and POLYNOVEA_PUBLIC_URL=http://localhost:3000)");
    }
    return mode;
  }
  return null;
}
