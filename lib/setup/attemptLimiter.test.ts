import { beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_CEILING, LOCK_MS, MAX_WRONG_ATTEMPTS, PRESSURE_SPACING_MS, checkAttempt, recordFailure, recordSuccess, resetAttemptLimiterForTests, sourceKey,
} from "./attemptLimiter";

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

function fail(key: string, times: number, start = T0, step = 1000) {
  let last = recordFailure(key, start);
  for (let i = 1; i < times; i += 1) last = recordFailure(key, start + i * step);
  return last;
}

beforeEach(() => resetAttemptLimiterForTests());

describe("sourceKey", () => {
  it("keys IPv4 per address", () => {
    expect(sourceKey("203.0.113.7")).toBe("v4:203.0.113.7");
    expect(sourceKey("203.0.113.8")).not.toBe(sourceKey("203.0.113.7"));
  });

  it("keys IPv6 per /64, however the address is written", () => {
    const a = sourceKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("v6:2001:0db8:0001:0002::/64");
    expect(sourceKey("2001:db8:1:2::1")).toBe(a);
    expect(sourceKey("2001:DB8:1:2:ffff::")).toBe(a);
    expect(sourceKey("2001:db8:1:3::1")).not.toBe(a);
    expect(sourceKey("::1")).toBe("v6:0000:0000:0000:0000::/64");
  });

  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(sourceKey("::ffff:203.0.113.7")).toBe("v4:203.0.113.7");
  });

  it("puts unreadable addresses in one bucket", () => {
    expect(sourceKey(null)).toBe("unknown");
    expect(sourceKey("not an ip")).toBe("unknown");
  });
});

describe("per-source lockout", () => {
  const ip = sourceKey("198.51.100.1");

  it("allows four wrong codes, locks on the fifth for 15 minutes", () => {
    expect(fail(ip, MAX_WRONG_ATTEMPTS - 1)).toEqual({ allowed: true });
    const fifth = recordFailure(ip, T0 + 10_000);
    expect(fifth).toEqual({ allowed: false, reason: "locked", retryAfterMs: LOCK_MS });
    expect(checkAttempt(ip, T0 + 10_000 + LOCK_MS - 1)).toMatchObject({ allowed: false, reason: "locked" });
  });

  it("unlocks once the 15 minutes are over, and a right code then clears the source", () => {
    fail(ip, MAX_WRONG_ATTEMPTS);
    const lockedAt = T0 + (MAX_WRONG_ATTEMPTS - 1) * 1000;
    expect(checkAttempt(ip, lockedAt + LOCK_MS)).toEqual({ allowed: true });
    recordSuccess(ip);
    // A fresh start: four more mistakes are allowed again.
    expect(fail(ip, MAX_WRONG_ATTEMPTS - 1, lockedAt + LOCK_MS)).toEqual({ allowed: true });
  });

  it("after a lock ends, the count starts again from zero", () => {
    fail(ip, MAX_WRONG_ATTEMPTS);
    const after = T0 + 5000 + LOCK_MS;
    expect(recordFailure(ip, after)).toEqual({ allowed: true });
  });

  it("old mistakes outside the window do not count towards a lock", () => {
    fail(ip, MAX_WRONG_ATTEMPTS - 1);
    expect(recordFailure(ip, T0 + LOCK_MS + 10_000)).toEqual({ allowed: true });
  });

  it("locks one IPv4 address without touching its neighbour", () => {
    fail(ip, MAX_WRONG_ATTEMPTS);
    expect(checkAttempt(ip, T0 + 6000).allowed).toBe(false);
    expect(checkAttempt(sourceKey("198.51.100.2"), T0 + 6000)).toEqual({ allowed: true });
  });

  it("locks a whole IPv6 /64, so rotating addresses inside it does not help", () => {
    for (let i = 0; i < MAX_WRONG_ATTEMPTS; i += 1) recordFailure(sourceKey(`2001:db8:5:6::${i + 1}`), T0 + i);
    expect(checkAttempt(sourceKey("2001:db8:5:6:dead:beef::9"), T0 + 10)).toMatchObject({ allowed: false, reason: "locked" });
    expect(checkAttempt(sourceKey("2001:db8:5:7::1"), T0 + 10)).toEqual({ allowed: true });
  });
});

describe("global ceiling", () => {
  function flood(count: number, start = T0) {
    for (let i = 0; i < count; i += 1) recordFailure(sourceKey(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`), start + i);
  }

  it("below the ceiling, a source that made one mistake can try again at once", () => {
    // The owner's own mistake is the 199th wrong code this hour: still under the ceiling.
    flood(GLOBAL_CEILING - 2);
    const owner = sourceKey("192.0.2.10");
    recordFailure(owner, T0 + 1000);
    expect(checkAttempt(owner, T0 + 1001)).toEqual({ allowed: true });
  });

  it("past the ceiling, every source is slowed to one attempt a minute, a new one included, never locked", () => {
    flood(GLOBAL_CEILING);
    const owner = sourceKey("192.0.2.10");
    const now = T0 + 5000;
    // A source seen for the first time waits too: its first request only starts the clock.
    expect(checkAttempt(owner, now)).toEqual({ allowed: false, reason: "slowed", retryAfterMs: PRESSURE_SPACING_MS });
    expect(checkAttempt(owner, now + PRESSURE_SPACING_MS - 1)).toMatchObject({ allowed: false, reason: "slowed" });
    expect(checkAttempt(owner, now + PRESSURE_SPACING_MS)).toEqual({ allowed: true });
    // The allowed attempt restarts the clock, so the next one waits again.
    expect(checkAttempt(owner, now + PRESSURE_SPACING_MS + 1)).toMatchObject({ allowed: false, reason: "slowed" });
    const afterMistake = recordFailure(owner, now + 2 * PRESSURE_SPACING_MS);
    expect(afterMistake).toEqual({ allowed: false, reason: "slowed", retryAfterMs: PRESSURE_SPACING_MS });
    expect(checkAttempt(owner, now + 3 * PRESSURE_SPACING_MS)).toEqual({ allowed: true });
  });

  it("an attacker rotating through new sources gets no free first attempt under pressure", () => {
    flood(GLOBAL_CEILING);
    const now = T0 + 5000;
    const allowed = Array.from({ length: 50 }, (_, i) => checkAttempt(sourceKey(`2001:db8:${i}::1`), now).allowed);
    expect(allowed.every((ok) => ok === false)).toBe(true);
  });

  it("an attacker keeping the ceiling full forever still cannot lock the owner out", () => {
    const owner = sourceKey("192.0.2.10");
    for (let minute = 0; minute < 120; minute += 5) {
      const now = T0 + minute * 60_000;
      flood(GLOBAL_CEILING, now);
      const first = checkAttempt(owner, now);
      // The owner waits out the spacing at most once and is then allowed.
      const decision = first.allowed ? first : checkAttempt(owner, now + first.retryAfterMs);
      expect(decision).toEqual({ allowed: true });
    }
  });

  it("pressure ends once the hour's wrong codes age out", () => {
    flood(GLOBAL_CEILING);
    const owner = sourceKey("192.0.2.10");
    const later = T0 + 61 * 60_000;
    recordFailure(owner, later);
    expect(checkAttempt(owner, later + 1)).toEqual({ allowed: true });
  });
});
