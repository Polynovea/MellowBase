/**
 * Runs once when the Next.js server starts. A malformed auth setting stops the server here, with the
 * detailed reason in the log, instead of failing every request.
 *
 * Boot tasks run first: they create the master key on first boot, take the auth secret from
 * config.enc when .env has none, and decide the mode (setup, running or unavailable).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runBootTasks } = await import("@/lib/setup/bootTasks");
  const state = await runBootTasks();
  // A fresh install has no auth secret until the wizard's database step saves config.enc; from then
  // on (owner step, running) the auth settings must be valid.
  if (state.mode === "setup" && !state.databaseReady) return;
  const { assertAuthSettings } = await import("@/lib/auth/settings");
  assertAuthSettings();
}
