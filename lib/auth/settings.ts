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
  }
}
