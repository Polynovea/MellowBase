/**
 * Strictly serial second-factor checks, one at a time per account.
 *
 * Better Auth guards a sign-in challenge's attempt budget by consuming a counter row and writing it
 * back afterwards. A parallel attempt that arrives in between does not wait: it fails at once with
 * INVALID_TWO_FACTOR_COOKIE and is never counted. Under load, how many wrong codes actually get
 * checked (and so whether a challenge is spent, or the account pauses) depends on timing. That is
 * the Phase 3 gate's 2-in-388 flake, and an attacker could steer the same timing.
 *
 * So TOTP and recovery-code checks for one account queue instead of racing:
 *
 * - Inside one process, a promise chain per account, so waiters cost nothing.
 * - Across processes, a lease row in `polynovea_auth."rateLimit"` (key `2fa-serial:<user id>`,
 *   `count` = a random owner token, `lastRequest` = lease expiry in ms). It needs no held database
 *   connection, so waiting can never starve the pool, and a crashed process's lease simply expires.
 *
 * The before hook in server.ts takes the lease once Better Auth has verified the signed challenge
 * cookie; the handler wrapper releases it in a `finally`, whatever the endpoint did.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";

/** Paths whose checks spend a sign-in challenge's attempts and the account's failure budget. */
export const SERIAL_VERIFICATION_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
]);

/** A check normally takes well under a second; a lease outlives a stuck one by this much. */
export const LEASE_TTL_MS = 30_000;
/** How long a queued check waits for its turn before answering 429. */
export const MAX_WAIT_MS = 30_000;

export interface LeaseStore {
  /** Take the lease for `key` if it is free or expired. True when this owner now holds it. */
  tryAcquire(key: string, token: number, ttlMs: number): Promise<boolean>;
  /** Give the lease back, only if this owner still holds it. */
  release(key: string, token: number): Promise<void>;
}

export class SerialGateBusyError extends Error {
  constructor() {
    super("Another sign-in check for this account is still running. Try again.");
    this.name = "SerialGateBusyError";
  }
}

export interface SerialGateOptions {
  store: LeaseStore;
  ttlMs?: number;
  maxWaitMs?: number;
  /** Tests pass a fake clock and sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SerialGate {
  /** Wait for this key's turn. Resolves to the release function, which never throws. */
  acquire(key: string): Promise<() => Promise<void>>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSerialGate(options: SerialGateOptions): SerialGate {
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const tails = new Map<string, Promise<void>>();

  return {
    async acquire(key) {
      const deadline = now() + maxWaitMs;

      // In-process queue: wait for everyone ahead of us on this key.
      const previous = tails.get(key) ?? Promise.resolve();
      let releaseLocal!: () => void;
      const mine = new Promise<void>((resolve) => { releaseLocal = resolve; });
      const tail = previous.then(() => mine);
      tails.set(key, tail);
      const finishLocal = () => {
        releaseLocal();
        if (tails.get(key) === tail) tails.delete(key);
      };
      await previous;

      // Cross-process lease, polled with a short backoff.
      const token = randomInt(1, 2 ** 31 - 1);
      let pause = 10;
      try {
        for (;;) {
          if (await options.store.tryAcquire(key, token, ttlMs)) break;
          if (now() >= deadline) throw new SerialGateBusyError();
          await sleep(Math.min(pause, Math.max(0, deadline - now())));
          pause = Math.min(pause * 2, 200);
        }
      } catch (error) {
        finishLocal();
        throw error;
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await options.store.release(key, token);
        } catch {
          // The lease expires on its own; never let a release failure change the response.
        } finally {
          finishLocal();
        }
      };
    },
  };
}

/** The lease store on the auth schema's rate-limit table (no migration needed: the keys never collide). */
export function createRateLimitLeaseStore(db: Kysely<DB>, table: string): LeaseStore {
  return {
    async tryAcquire(key, token, ttlMs) {
      const current = Date.now();
      const { rows } = await sql<{ count: number }>`
        insert into ${sql.table(table)} as r ("key", "count", "lastRequest")
        values (${key}, ${token}, ${current + ttlMs})
        on conflict ("key") do update
          set "count" = excluded."count", "lastRequest" = excluded."lastRequest"
          where r."lastRequest" < ${current}
        returning "count"`.execute(db);
      return Number(rows[0]?.count) === token;
    },
    async release(key, token) {
      await sql`delete from ${sql.table(table)} where "key" = ${key} and "count" = ${token}`.execute(db);
    },
  };
}

export function serialVerificationKey(userId: string): string {
  return `2fa-serial:${userId}`;
}

/** Per-request scope: leases taken during one handler call, released when it ends. */
type Scope = { releases: (() => Promise<void>)[]; held: Set<string> };
const scopes = new AsyncLocalStorage<Scope>();

/** Run one auth request; every lease taken while it runs is released when it ends, success or not. */
export async function runSerialScope<T>(fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { releases: [], held: new Set() };
  try {
    return await scopes.run(scope, fn);
  } finally {
    for (const release of scope.releases.splice(0).reverse()) await release();
  }
}

/**
 * Wait for this key's turn and hold it until the current request ends. Outside a request scope
 * (direct server-side auth.api calls) nothing is taken, so nothing can leak; only the HTTP handler,
 * which is what browsers reach, is serialised.
 */
export async function holdForRequest(gate: SerialGate, key: string): Promise<boolean> {
  const scope = scopes.getStore();
  if (!scope || scope.held.has(key)) return false;
  const release = await gate.acquire(key);
  scope.held.add(key);
  scope.releases.push(release);
  return true;
}
