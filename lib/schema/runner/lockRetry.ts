// Lock timeout and retries for schema changes.
//
// An ALTER TABLE that waits for a lock queues every later query on that table behind it; GoCardless
// lost 15 seconds of traffic exactly this way. So every statement the runner sends waits at most
// LOCK_TIMEOUT_MS for its lock. If it does not get it, the transaction rolls back (its locks are
// released at once, so the queue behind it drains), the runner sleeps, and tries again: five retries
// with backoff of about 1, 2, 4, 8 and 16 seconds. A query holding a lock for 30 seconds therefore
// makes the change wait, never the other queries for longer than LOCK_TIMEOUT_MS.
import { LOCK_CONFLICT_STATES, sqlState } from "@/lib/schema/runner/errors";

export const LOCK_TIMEOUT_MS = 3_000;
export const MAX_LOCK_RETRIES = 5;
export const BACKOFF_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000]);
/** Each sleep is scaled by a random factor in [1 - JITTER, 1 + JITTER], so two workers do not retry in step. */
export const JITTER = 0.2;

export interface LockRetryOptions {
  retries?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each sleep: the retry number (1-based) and the delay. */
  onRetry?: (retry: number, delayMs: number) => void;
}

export interface LockRetryResult<T> {
  value: T;
  /** How many times the attempt was retried after a lock conflict. */
  retries: number;
}

export function isLockConflict(error: unknown): boolean {
  const state = sqlState(error);
  return state !== null && LOCK_CONFLICT_STATES.has(state);
}

export const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffDelay(retry: number, backoffMs: readonly number[] = BACKOFF_MS, random: () => number = Math.random): number {
  const base = backoffMs[Math.min(retry - 1, backoffMs.length - 1)] ?? 0;
  const factor = 1 - JITTER + random() * 2 * JITTER;
  return Math.max(0, Math.round(base * factor));
}

/**
 * Runs `attempt` and retries it after a lock conflict (lock_timeout or deadlock). The attempt must be
 * self-contained: its transaction has rolled back before this sleeps, so no lock is held while waiting.
 * Any other error, or the last lock conflict, is thrown unchanged.
 */
export async function withLockRetry<T>(attempt: (attemptNumber: number) => Promise<T>, options: LockRetryOptions = {}): Promise<LockRetryResult<T>> {
  const retries = options.retries ?? MAX_LOCK_RETRIES;
  const sleep = options.sleep ?? realSleep;
  for (let retry = 0; ; retry += 1) {
    try {
      return { value: await attempt(retry + 1), retries: retry };
    } catch (error) {
      if (!isLockConflict(error) || retry >= retries) throw error;
      const delay = backoffDelay(retry + 1, options.backoffMs, options.random);
      options.onRetry?.(retry + 1, delay);
      await sleep(delay);
    }
  }
}
