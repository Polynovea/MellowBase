import { describe, expect, it } from "vitest";
import { errorCode, RefusedError, RunnerError } from "@/lib/schema/runner/errors";
import { BACKOFF_MS, backoffDelay, concurrentLockTimeoutMs, DEFAULT_CONCURRENT_LOCK_TIMEOUT_MS, JITTER, MAX_LOCK_RETRIES, withLockRetry } from "@/lib/schema/runner/lockRetry";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe("withLockRetry", () => {
  it("retries a lock timeout five times with growing backoff, then gives up", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await expect(withLockRetry(async () => {
      attempts += 1;
      throw pgError("55P03");
    }, { sleep: async (ms) => { delays.push(ms); }, random: () => 0.5 })).rejects.toMatchObject({ code: "55P03" });
    expect(attempts).toBe(1 + MAX_LOCK_RETRIES);
    expect(delays).toEqual([...BACKOFF_MS]);
  });

  it("returns the value and the retry count once the lock is free", async () => {
    let attempts = 0;
    const result = await withLockRetry(async (n) => {
      attempts = n;
      if (n < 3) throw pgError("55P03");
      return "done";
    }, { sleep: async () => undefined });
    expect(result).toEqual({ value: "done", retries: 2 });
    expect(attempts).toBe(3);
  });

  it("retries a deadlock too, but never any other error", async () => {
    let deadlocks = 0;
    await withLockRetry(async () => {
      if (deadlocks++ === 0) throw pgError("40P01");
    }, { sleep: async () => undefined });
    expect(deadlocks).toBe(2);

    let other = 0;
    await expect(withLockRetry(async () => {
      other += 1;
      throw pgError("23505");
    }, { sleep: async () => undefined })).rejects.toMatchObject({ code: "23505" });
    expect(other).toBe(1);
  });

  it("keeps jitter within 20 % of the base delay", () => {
    for (let retry = 1; retry <= MAX_LOCK_RETRIES; retry += 1) {
      const base = BACKOFF_MS[retry - 1];
      expect(backoffDelay(retry, BACKOFF_MS, () => 0)).toBe(Math.round(base * (1 - JITTER)));
      expect(backoffDelay(retry, BACKOFF_MS, () => 1)).toBe(Math.round(base * (1 + JITTER)));
    }
  });
});

describe("concurrentLockTimeoutMs", () => {
  it("is 10 minutes unless the operator sets a positive whole number", () => {
    expect(concurrentLockTimeoutMs({})).toBe(DEFAULT_CONCURRENT_LOCK_TIMEOUT_MS);
    expect(DEFAULT_CONCURRENT_LOCK_TIMEOUT_MS).toBe(600_000);
    expect(concurrentLockTimeoutMs({ POLYNOVEA_MIGRATION_CONCURRENT_LOCK_TIMEOUT_MS: "90000" })).toBe(90_000);
    for (const bad of ["0", "-5", "abc", "1.5"]) expect(concurrentLockTimeoutMs({ POLYNOVEA_MIGRATION_CONCURRENT_LOCK_TIMEOUT_MS: bad })).toBe(DEFAULT_CONCURRENT_LOCK_TIMEOUT_MS);
  });
});

describe("error codes", () => {
  it("are codes only, never messages or SQL", () => {
    expect(errorCode(pgError("55P03"))).toBe("lock_timeout_exhausted");
    expect(errorCode(pgError("23514"))).toBe("check_violation");
    expect(errorCode(pgError("22P02"))).toBe("pg_22p02");
    expect(errorCode(new Error('relation "content.m_secret" does not exist'))).toBe("internal_error");
    expect(errorCode(new RefusedError("plan_hash_mismatch"))).toBe("plan_hash_mismatch");
    expect(new RunnerError("Not A Code; drop table x").code).toBe("internal_error");
  });
});
