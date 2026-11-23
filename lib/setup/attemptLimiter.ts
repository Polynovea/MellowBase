import { isIP } from "node:net";

/**
 * Wrong-code throttling for the setup code (acceptance test 2).
 *
 * - Per source: 5 wrong codes lock that source for 15 minutes. A source is one IPv4 address or one
 *   IPv6 /64 (one home or one VM usually gets a whole /64, so per-address limits would be free to
 *   dodge). The client address comes from the trusted-proxy rule in requestGuards.ts.
 * - Global ceiling: past 200 wrong codes in an hour, every source must wait a minute between
 *   attempts, including a source seen for the first time (its first request only starts the
 *   clock). That slows a distributed guesser but never locks the wizard outright: a single global
 *   lock was rejected because anyone on the internet could keep setup locked forever.
 * - In memory only. A restart resets it, together with the code it protects.
 *
 * A right code is still refused while its source is locked or waiting; once the wait is over it
 * works, and it clears that source's failures.
 */

export const MAX_WRONG_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const GLOBAL_CEILING = 200;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const PRESSURE_SPACING_MS = 60 * 1000;
/** Bounds memory when many sources guess at once; the oldest are dropped first. */
export const MAX_TRACKED_SOURCES = 10_000;

interface SourceState {
  failures: number[];
  lockedUntil: number;
  lastAttempt: number;
}

interface LimiterState {
  sources: Map<string, SourceState>;
  /** Times of the most recent wrong codes, at most GLOBAL_CEILING of them. */
  recentFailures: number[];
}

export type AttemptDecision = { allowed: true } | { allowed: false; reason: "locked" | "slowed"; retryAfterMs: number };

const STATE_KEY = Symbol.for("polynovea.setup.attemptLimiter");
const store = globalThis as typeof globalThis & { [STATE_KEY]?: LimiterState };

function state(): LimiterState {
  return (store[STATE_KEY] ??= { sources: new Map(), recentFailures: [] });
}

function expandIpv6(address: string): string[] | null {
  let text = address.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = text.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  return groups.map((group) => group.padStart(4, "0"));
}

/** The throttling bucket for a client address: the IPv4 address, or the IPv6 /64. */
export function sourceKey(address: string | null): string {
  if (!address) return "unknown";
  const family = isIP(address);
  if (family === 4) return `v4:${address}`;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return `v4:${mapped[1]}`;
    const groups = expandIpv6(address);
    if (groups) return `v6:${groups.slice(0, 4).join(":")}::/64`;
  }
  return "unknown";
}

function globalPressure(now: number): boolean {
  const recent = state().recentFailures;
  return recent.length >= GLOBAL_CEILING && now - recent[0] < GLOBAL_WINDOW_MS;
}

function prune(now: number): void {
  const { sources } = state();
  for (const [key, source] of sources) {
    if (source.lockedUntil <= now && now - source.lastAttempt > LOCK_MS) sources.delete(key);
  }
}

function track(key: string, now: number): SourceState {
  const limiter = state();
  let source = limiter.sources.get(key);
  if (!source) {
    if (limiter.sources.size >= MAX_TRACKED_SOURCES) prune(now);
    if (limiter.sources.size >= MAX_TRACKED_SOURCES) {
      const oldest = limiter.sources.keys().next().value;
      if (oldest !== undefined) limiter.sources.delete(oldest);
    }
    source = { failures: [], lockedUntil: 0, lastAttempt: now };
    limiter.sources.set(key, source);
  }
  return source;
}

/**
 * Whether this source may try a code now. Under global pressure it also starts the source's
 * one-a-minute clock: a first-time source waits a minute too, and an allowed attempt resets it.
 */
export function checkAttempt(key: string, now: number = Date.now()): AttemptDecision {
  const existing = state().sources.get(key);
  if (existing && existing.lockedUntil > now) return { allowed: false, reason: "locked", retryAfterMs: existing.lockedUntil - now };
  if (!globalPressure(now)) return { allowed: true };
  if (!existing) {
    track(key, now);
    return { allowed: false, reason: "slowed", retryAfterMs: PRESSURE_SPACING_MS };
  }
  const wait = existing.lastAttempt + PRESSURE_SPACING_MS - now;
  if (wait > 0) return { allowed: false, reason: "slowed", retryAfterMs: wait };
  existing.lastAttempt = now;
  return { allowed: true };
}

/** Counts a wrong code. Returns the decision for this source's next attempt. */
export function recordFailure(key: string, now: number = Date.now()): AttemptDecision {
  const limiter = state();
  const source = track(key, now);
  source.lastAttempt = now;
  // Only failures inside the lock window count towards a lock; an old mistake does not.
  source.failures = source.failures.filter((at) => now - at < LOCK_MS);
  source.failures.push(now);
  if (source.failures.length >= MAX_WRONG_ATTEMPTS) {
    source.lockedUntil = now + LOCK_MS;
    source.failures = [];
  }

  limiter.recentFailures.push(now);
  if (limiter.recentFailures.length > GLOBAL_CEILING) limiter.recentFailures.splice(0, limiter.recentFailures.length - GLOBAL_CEILING);
  return checkAttempt(key, now);
}

/** A right code: forget this source's failures. */
export function recordSuccess(key: string): void {
  state().sources.delete(key);
}

/** Tests only: forget everything, as a restart would. */
export function resetAttemptLimiterForTests(): void {
  delete store[STATE_KEY];
}
