import { describe, expect, it } from "vitest";
import { isTransientConnectionError, retryOnRestart, waitForStableDatabase } from "./waitForDatabase.mjs";

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    sleeps,
  };
}

const terminated = () => new Error("Connection terminated unexpectedly");
const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:26000"), { code: "ECONNREFUSED" });

describe("isTransientConnectionError", () => {
  it("treats a cut connection, a refused connection and a starting server as transient", () => {
    expect(isTransientConnectionError(terminated())).toBe(true);
    expect(isTransientConnectionError(refused())).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("the database system is starting up"), { code: "57P03" }))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).toBe(true);
  });

  it("never treats SQL or login errors as transient", () => {
    expect(isTransientConnectionError(Object.assign(new Error("password authentication failed"), { code: "28P01" }))).toBe(false);
    expect(isTransientConnectionError(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
  });
});

describe("waitForStableDatabase", () => {
  it("returns after three successful checks in a row", async () => {
    const clock = fakeClock();
    let calls = 0;
    await waitForStableDatabase(async () => { calls += 1; }, clock);
    expect(calls).toBe(3);
  });

  it("restarts the count when the server restarts between checks (the init hand-over)", async () => {
    const clock = fakeClock();
    const results = ["ok", terminated(), "ok", "ok", "ok"];
    let calls = 0;
    await waitForStableDatabase(async () => {
      const next = results[calls++];
      if (next instanceof Error) throw next;
    }, clock);
    expect(calls).toBe(5);
  });

  it("backs off from 250 ms, doubling up to 2 s", async () => {
    const clock = fakeClock();
    let calls = 0;
    await waitForStableDatabase(async () => {
      calls += 1;
      if (calls <= 6) throw refused();
    }, { ...clock, stableGapMs: 500 });
    expect(clock.sleeps.slice(0, 6)).toEqual([250, 500, 1000, 2000, 2000, 2000]);
  });

  it("gives up after the timeout with the last error", async () => {
    const clock = fakeClock();
    await expect(waitForStableDatabase(async () => { throw terminated(); }, { ...clock, timeoutMs: 5_000 }))
      .rejects.toThrow(/did not stay up .* within 5 s .*Connection terminated unexpectedly/);
    expect(clock.now()).toBeLessThanOrEqual(5_000);
  });

  it("throws a non-transient error at once", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(waitForStableDatabase(async () => {
      calls += 1;
      throw Object.assign(new Error("password authentication failed"), { code: "28P01" });
    }, clock)).rejects.toThrow(/password authentication failed/);
    expect(calls).toBe(1);
  });
});

describe("retryOnRestart", () => {
  it("re-runs a step whose connection was cut, after waiting again", async () => {
    let calls = 0;
    let waits = 0;
    const result = await retryOnRestart(async () => {
      calls += 1;
      if (calls === 1) throw terminated();
      return "done";
    }, { waitAgain: async () => { waits += 1; } });
    expect(result).toBe("done");
    expect(calls).toBe(2);
    expect(waits).toBe(1);
  });

  it("stops after three attempts", async () => {
    let calls = 0;
    await expect(retryOnRestart(async () => { calls += 1; throw terminated(); })).rejects.toThrow(/Connection terminated/);
    expect(calls).toBe(3);
  });

  it("does not repeat a step that failed for another reason", async () => {
    let calls = 0;
    await expect(retryOnRestart(async () => { calls += 1; throw new Error("relation does not exist"); })).rejects.toThrow(/relation/);
    expect(calls).toBe(1);
  });
});
