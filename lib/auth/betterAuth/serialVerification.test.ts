import { describe, expect, it } from "vitest";
import { createSerialGate, holdForRequest, runSerialScope, SerialGateBusyError, serialVerificationKey, SERIAL_VERIFICATION_PATHS, type LeaseStore } from "@/lib/auth/betterAuth/serialVerification";

/** An in-memory lease table with the same rules as the database one. */
function memoryStore(clock: () => number = Date.now) {
  const leases = new Map<string, { token: number; expires: number }>();
  const store: LeaseStore & { leases: typeof leases; acquires: number; renewals: number } = {
    leases,
    acquires: 0,
    renewals: 0,
    async tryAcquire(key, token, ttlMs) {
      store.acquires += 1;
      const current = leases.get(key);
      if (current && current.expires >= clock()) return false;
      leases.set(key, { token, expires: clock() + ttlMs });
      return true;
    },
    async renew(key, token, ttlMs) {
      const current = leases.get(key);
      if (current?.token !== token) return false;
      store.renewals += 1;
      current.expires = clock() + ttlMs;
      return true;
    },
    async release(key, token) {
      if (leases.get(key)?.token === token) leases.delete(key);
    },
  };
  return store;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe("serial second-factor checks", () => {
  it("covers exactly the second-factor verification paths", () => {
    expect([...SERIAL_VERIFICATION_PATHS].sort()).toEqual(["/two-factor/verify-backup-code", "/two-factor/verify-otp", "/two-factor/verify-totp"]);
    expect(serialVerificationKey("u1")).toBe("2fa-serial:u1");
  });

  it("runs checks for one account strictly one at a time, in arrival order", async () => {
    const gate = createSerialGate({ store: memoryStore() });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(Array.from({ length: 25 }, async (_, i) => {
      const release = await gate.acquire("2fa-serial:a");
      running += 1;
      peak = Math.max(peak, running);
      await tick();
      order.push(i);
      running -= 1;
      await release();
    }));
    expect(peak).toBe(1);
    expect(order).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("does not hold up other accounts", async () => {
    const gate = createSerialGate({ store: memoryStore() });
    const releaseA = await gate.acquire("2fa-serial:a");
    const releaseB = await gate.acquire("2fa-serial:b");
    await releaseB();
    await releaseA();
  });

  it("waits for a lease held by another process, then takes it", async () => {
    const store = memoryStore();
    store.leases.set("2fa-serial:a", { token: 7, expires: Date.now() + 60_000 });
    const gate = createSerialGate({ store });
    const pending = gate.acquire("2fa-serial:a");
    await tick();
    expect(store.acquires).toBeGreaterThan(0);
    await store.release("2fa-serial:a", 7);
    const release = await pending;
    expect(store.leases.has("2fa-serial:a")).toBe(true);
    await release();
    expect(store.leases.has("2fa-serial:a")).toBe(false);
  });

  it("takes over a lease whose holder died once it expires", async () => {
    let now = 1_000;
    const store = memoryStore(() => now);
    store.leases.set("2fa-serial:a", { token: 7, expires: 1_500 });
    const gate = createSerialGate({ store, now: () => now, sleep: async (ms) => { now += ms; } });
    const release = await gate.acquire("2fa-serial:a");
    expect(now).toBeGreaterThan(1_500);
    await release();
  });

  it("answers busy after the maximum wait, and frees the queue for the next caller", async () => {
    let now = 0;
    const store = memoryStore(() => now);
    store.leases.set("2fa-serial:a", { token: 7, expires: 10_000_000 });
    const gate = createSerialGate({ store, maxWaitMs: 1_000, now: () => now, sleep: async (ms) => { now += ms; } });
    await expect(gate.acquire("2fa-serial:a")).rejects.toBeInstanceOf(SerialGateBusyError);
    store.leases.clear();
    const release = await gate.acquire("2fa-serial:a");
    await release();
  });

  it("never lets a failed release break the response, and releases the local queue anyway", async () => {
    const store = memoryStore();
    store.release = async () => { throw new Error("database gone"); };
    const gate = createSerialGate({ store });
    const release = await gate.acquire("2fa-serial:a");
    await expect(release()).resolves.toBeUndefined();
    store.leases.clear();
    const next = await gate.acquire("2fa-serial:a");
    await next();
  });

  it("a request scope releases what it took, even when the request throws", async () => {
    const store = memoryStore();
    const gate = createSerialGate({ store });
    await expect(runSerialScope(async () => {
      expect(await holdForRequest(gate, "2fa-serial:a")).toBe(true);
      // Taking the same key twice in one request is a no-op, not a self-deadlock.
      expect(await holdForRequest(gate, "2fa-serial:a")).toBe(false);
      expect(store.leases.has("2fa-serial:a")).toBe(true);
      throw new Error("endpoint failed");
    })).rejects.toThrow("endpoint failed");
    expect(store.leases.size).toBe(0);
  });

  it("outside a request scope nothing is taken, so nothing can leak", async () => {
    const store = memoryStore();
    const gate = createSerialGate({ store });
    expect(await holdForRequest(gate, "2fa-serial:a")).toBe(false);
    expect(store.acquires).toBe(0);
  });
});

describe("security review: clocks, deadlines, renewal", () => {
  it("(1) replicas with clocks 60 s apart still exclude each other: lease expiry uses only the store's clock", async () => {
    const shared = memoryStore(); // the database: one clock for everyone
    const ahead = createSerialGate({ store: shared, maxWaitMs: 60, now: () => Date.now() + 60_000 });
    const behind = createSerialGate({ store: shared, maxWaitMs: 60, now: () => Date.now() - 60_000 });
    const release = await ahead.acquire("2fa-serial:a");
    await expect(behind.acquire("2fa-serial:a")).rejects.toBeInstanceOf(SerialGateBusyError);
    await release();
    const second = await behind.acquire("2fa-serial:a");
    await expect(ahead.acquire("2fa-serial:a")).rejects.toBeInstanceOf(SerialGateBusyError);
    await second();
  });

  it("(1) the database store sends the same SQL and parameters whatever the server clock says", async () => {
    const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } = await import("kysely");
    const { createRateLimitLeaseStore } = await import("@/lib/auth/betterAuth/serialVerification");
    const captured: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const db = new Kysely<never>({
      dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() },
      log: (event) => { if (event.level === "query") captured.push({ sql: event.query.sql, parameters: event.query.parameters }); },
    });
    const store = createRateLimitLeaseStore(db as never, "polynovea_auth.rateLimit");
    const realNow = Date.now;
    for (const offset of [-3_600_000, 3_600_000]) {
      Date.now = () => realNow() + offset;
      try {
        await store.tryAcquire("2fa-serial:a", 42, 30_000);
        await store.renew("2fa-serial:a", 42, 30_000);
      } finally {
        Date.now = realNow;
      }
    }
    expect(captured).toHaveLength(4);
    expect(captured[0]).toEqual(captured[2]);
    expect(captured[1]).toEqual(captured[3]);
    for (const query of captured) {
      expect(query.sql).toContain("clock_timestamp()");
      expect(query.parameters.every((p) => typeof p !== "number" || p < 1e9)).toBe(true); // no epoch-ms from a server clock
    }
  });

  it("(2) a hung request ahead in the queue makes later ones answer busy at the deadline, never wait forever", async () => {
    const store = memoryStore();
    const gate = createSerialGate({ store, maxWaitMs: 40 });
    const hung = await gate.acquire("2fa-serial:a"); // never released during the wait
    const started = Date.now();
    await expect(gate.acquire("2fa-serial:a")).rejects.toBeInstanceOf(SerialGateBusyError);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The timed-out waiter left the queue: once the hung one finishes, the next caller goes straight through.
    await hung();
    const next = await gate.acquire("2fa-serial:a");
    await next();
  });

  it("(3) the lease outlives the longest wait and is renewed while the check runs, up to the hold limit", async () => {
    const { LEASE_TTL_MS, MAX_WAIT_MS, MAX_HOLD_MS } = await import("@/lib/auth/betterAuth/serialVerification");
    expect(LEASE_TTL_MS).toBeGreaterThan(MAX_WAIT_MS);
    expect(MAX_HOLD_MS).toBeGreaterThan(LEASE_TTL_MS);
    const store = memoryStore();
    const gate = createSerialGate({ store, ttlMs: 30, maxHoldMs: 10_000 });
    const release = await gate.acquire("2fa-serial:a");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(store.renewals).toBeGreaterThanOrEqual(2);
    expect(store.leases.get("2fa-serial:a")!.expires).toBeGreaterThan(Date.now());
    await release();
    const after = store.renewals;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.renewals).toBe(after);

    const capped = memoryStore();
    const short = createSerialGate({ store: capped, ttlMs: 15, maxHoldMs: 20 });
    const held = await short.acquire("2fa-serial:b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const renewalsAtCap = capped.renewals;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capped.renewals).toBe(renewalsAtCap);
    await held();
  });
});
