/**
 * Runs once when the Next.js server starts. A malformed auth setting stops the server here, with the
 * detailed reason in the log, instead of failing every request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertAuthSettings } = await import("@/lib/auth/settings");
  assertAuthSettings();
}
