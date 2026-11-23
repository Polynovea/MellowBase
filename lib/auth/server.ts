import type { ServerIdentityProvider } from "@/lib/auth/provider";
import { serverAuthProvider } from "@/lib/auth/settings";
import { getSupabaseServerIdentityProvider } from "@/lib/auth/supabaseProvider";
import { getBuiltinServerIdentityProvider } from "@/lib/auth/betterAuth/instance";

/** The server identity provider selected by AUTH_PROVIDER. */
export function getServerIdentityProvider(): ServerIdentityProvider {
  return serverAuthProvider() === "builtin" ? getBuiltinServerIdentityProvider() : getSupabaseServerIdentityProvider();
}
