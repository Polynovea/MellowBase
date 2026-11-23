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

/** Checked when the server starts (instrumentation.ts), so a typo or mismatch stops the deploy. */
export function assertAuthSettings(): void {
  const server = serverAuthProvider();
  const browser = parseAuthProvider(process.env.NEXT_PUBLIC_AUTH_PROVIDER);
  if (server !== browser) {
    throw new Error(`AUTH_PROVIDER (${server}) and NEXT_PUBLIC_AUTH_PROVIDER (${browser}) must match`);
  }
  if (server === "builtin") {
    if ((process.env.POLYNOVEA_AUTH_SECRET ?? "").length < 32) throw new Error("POLYNOVEA_AUTH_SECRET must be at least 32 characters for the built-in auth");
    if (!process.env.POLYNOVEA_PUBLIC_URL) throw new Error("POLYNOVEA_PUBLIC_URL is required for the built-in auth");
    const proxies = parseTrustedProxies(process.env.POLYNOVEA_TRUSTED_PROXIES);
    // Without the proxy list, a client could choose its own rate-limit bucket with X-Forwarded-For.
    if (process.env.NODE_ENV === "production" && proxies.length === 0) {
      throw new Error("POLYNOVEA_TRUSTED_PROXIES must list the reverse proxies in front of the app for the built-in auth");
    }
  }
}
