// Waiting for the local test database to really be up.
//
// The PostgreSQL image initialises a new data directory with a temporary server, stops it, then
// starts the real one. Compose can report the container healthy during that hand-over, so the first
// connection from setup.mjs sometimes fails with "Connection terminated unexpectedly". These helpers
// wait until the server answers a real query several times in a row, and retry a setup step whose
// connection was cut while the server restarted.

const TRANSIENT_CODES = new Set([
  "57P01", // admin_shutdown: the init server stopping under us
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now: the server is starting up
  "08000", "08001", "08003", "08004", "08006", // connection exceptions
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT",
]);

const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /terminating connection/i,
  /the database system is (starting up|shutting down)/i,
  /server closed the connection unexpectedly/i,
];

/** True for errors that mean the server was not reachable yet or restarted, never for SQL errors. */
export function isTransientConnectionError(error) {
  if (!error || typeof error !== "object") return false;
  if (typeof error.code === "string" && TRANSIENT_CODES.has(error.code)) return true;
  const message = typeof error.message === "string" ? error.message : "";
  return TRANSIENT_MESSAGES.some((pattern) => pattern.test(message));
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once `probe()` (one connection running `select 1`) succeeds `stableChecks` times in a row,
 * `stableGapMs` apart. A transient failure resets the count and backs off (250 ms doubling to 2 s).
 * A non-transient error is thrown at once. Gives up after `timeoutMs`.
 */
export async function waitForStableDatabase(probe, {
  timeoutMs = 30_000,
  stableChecks = 3,
  stableGapMs = 500,
  sleep = realSleep,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let delay = 250;
  let streak = 0;
  let lastError = null;
  for (;;) {
    try {
      await probe();
      streak += 1;
      delay = 250;
      if (streak >= stableChecks) return;
      await sleep(stableGapMs);
      continue;
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error;
      lastError = error;
      streak = 0;
    }
    if (now() + delay > deadline) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`The test database did not stay up for ${stableChecks} checks within ${Math.round(timeoutMs / 1000)} s (last error: ${reason}).`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }
}

/**
 * Runs `step()`, and runs it again (up to `attempts` times in all) when it fails because the
 * connection was cut, after waiting for the database to be stable again. Steps must be safe to repeat.
 */
export async function retryOnRestart(step, { attempts = 3, waitAgain = async () => {}, onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (attempt >= attempts || !isTransientConnectionError(error)) throw error;
      onRetry(attempt, error);
      await waitAgain();
    }
  }
}
