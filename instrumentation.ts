/**
 * Runs once when the Next.js server starts. A malformed POLYNOVEA_DATA_BACKEND stops the server here,
 * with the detailed reason in the log, instead of failing every request that reaches a switched area.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertDataBackendSetting } = await import("@/lib/db/backend");
  assertDataBackendSetting();
}
