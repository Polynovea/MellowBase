/**
 * The process-wide built-in auth instance, configured from the environment:
 * POLYNOVEA_AUTH_SECRET (32+ characters, never stored in the database), POLYNOVEA_PUBLIC_URL and
 * POLYNOVEA_TRUSTED_PROXIES (comma-separated addresses or CIDR ranges of the reverse proxies).
 * Kept on globalThis, like the database pool, so Next.js reloads do not build a second one.
 */
import { getDb } from "@/lib/db/index";
import { provisionManagedIdentity } from "@/lib/admin/managedProvisioning";
import { clientAddressMode, parseTrustedProxies } from "@/lib/auth/settings";
import { createPolynoveaAuth, type PolynoveaAuth } from "@/lib/auth/betterAuth/server";
import { getBetterAuthServerIdentityProvider } from "@/lib/auth/betterAuth/provider";
import type { ServerIdentityProvider } from "@/lib/auth/provider";

const KEY = Symbol.for("polynovea.builtinAuth");
type Holder = { [KEY]?: PolynoveaAuth };

export function getBuiltinAuth(): PolynoveaAuth {
  const holder = globalThis as Holder;
  if (!holder[KEY]) {
    const secret = process.env.POLYNOVEA_AUTH_SECRET ?? "";
    const baseURL = process.env.POLYNOVEA_PUBLIC_URL ?? "";
    if (!baseURL) throw new Error("POLYNOVEA_PUBLIC_URL is required for the built-in auth");
    holder[KEY] = createPolynoveaAuth({
      db: getDb(),
      secret,
      baseURL,
      trustedProxies: parseTrustedProxies(process.env.POLYNOVEA_TRUSTED_PROXIES),
      // SSH-tunnel install (loopback bind, loopback http address, no proxy): no client address header.
      clientAddressMode: clientAddressMode(process.env),
      onUserCreated: async (user) => {
        await provisionManagedIdentity(user);
      },
    });
  }
  return holder[KEY]!;
}

/** Test hook: forget the instance so the next call reads the environment again. */
export function resetBuiltinAuthForTests(): void {
  delete (globalThis as Holder)[KEY];
}

export function getBuiltinServerIdentityProvider(): ServerIdentityProvider {
  return getBetterAuthServerIdentityProvider(getBuiltinAuth());
}
