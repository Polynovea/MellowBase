/**
 * Vitest setup for unit tests: the auth settings of the shell that runs the tests must never leak
 * into them. Each test that needs the built-in auth sets these itself; everything else runs with
 * the defaults (AUTH_PROVIDER unset = supabase).
 */
export const AUTH_ENV_VARIABLES = [
  "AUTH_PROVIDER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "POLYNOVEA_AUTH_SECRET",
  "POLYNOVEA_PUBLIC_URL",
  "POLYNOVEA_TRUSTED_PROXIES",
  "POLYNOVEA_BREACHED_PASSWORDS_FILE",
] as const;

for (const name of AUTH_ENV_VARIABLES) delete process.env[name];
// Unit tests never call the Have I Been Pwned API.
process.env.POLYNOVEA_HIBP_DISABLED = "true";
