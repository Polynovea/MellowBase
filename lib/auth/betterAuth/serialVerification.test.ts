import { describe, expect, it } from "vitest";
import { createSerialGate, holdForRequest, runSerialScope, SerialGateBusyError, serialVerificationKey, SERIAL_VERIFICATION_PATHS, type LeaseStore } from "@/lib/auth/betterAuth/serialVerification";

/** An in-memory lease table with the same rules as the database one. */
function memoryStore(clock: () => number = Date.now) {
  const leases = new Map<string, { token: number; expires: number }>();
  const store: LeaseStore & { leases: typeof leases; acquires: number } = {
    leases,
    acquires: 0,
    async tryAcquire(key, token, ttlMs) {
      store.acquires += 1;
      const current = leases.get(key);
      if (current && current.expires >= clock()) return false;
      leases.set(key, { token, expires: clock() + ttlMs });
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
