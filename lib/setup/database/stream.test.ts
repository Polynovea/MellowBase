import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DatabaseSetupError } from "./errors";
import { createRunRateLimiter, createStreamLimiter, formatEvent, setupEventStream } from "./stream";

const SECRET = "Adm1n-S3cret-Pa55word!";

let logged: MockInstance;
beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => logged.mockRestore());

describe("formatEvent", () => {
  it("writes one server-sent event per progress event", () => {
    expect(formatEvent({ type: "check", id: "dns", label: "Finding the database", status: "passed" }))
      .toBe('event: check\ndata: {"type":"check","id":"dns","label":"Finding the database","status":"passed"}\n\n');
  });

  it("redacts a secret still in scope, even if something put it in an event", () => {
    const text = formatEvent({ type: "error", message: `boom ${SECRET}` }, [SECRET]);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[redacted]");
  });
});

describe("setupEventStream", () => {
  it("streams events, ends with a plain error on failure and releases its slot", async () => {
    const onFinish = vi.fn();
    const response = setupEventStream(async (emit) => {
      emit({ type: "check", id: "dns", label: "Finding the database", status: "running" });
      throw new DatabaseSetupError("Plain fix.", "check dns", "abcd1234");
    }, { onFinish });
    const text = await response.text();
    expect(text).toBe(
      'event: check\ndata: {"type":"check","id":"dns","label":"Finding the database","status":"running"}\n\n'
      + 'event: error\ndata: {"type":"error","message":"Plain fix. (ref abcd1234)"}\n\n',
    );
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("never shows a raw error, and redacts held secrets from the server log too", async () => {
    const response = setupEventStream(async () => {
      throw Object.assign(new Error(`connect ECONNREFUSED 10.0.0.1:5432 password=${SECRET}`), { code: "ECONNREFUSED" });
    }, { secrets: () => [SECRET] });
    const text = await response.text();
    expect(text).toMatch(/"message":"The database step failed unexpectedly \(ref [0-9a-f]{8}\)"/);
    expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET);
  });

  it("keeps running to a consistent end when the browser goes away", async () => {
    let finished = false;
    const response = setupEventStream(async (emit) => {
      emit({ type: "check", id: "dns", label: "x", status: "running" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      emit({ type: "check", id: "dns", label: "x", status: "passed" });
      finished = true;
    });
    await response.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finished).toBe(true);
  });
});

describe("createStreamLimiter", () => {
  it("allows one stream per setup session and a fixed number in total", () => {
    const limiter = createStreamLimiter(2);
    const a = limiter.acquire("a");
    expect(a).toBeTypeOf("function");
    expect(limiter.acquire("a")).toBeNull();
    const b = limiter.acquire("b");
    expect(limiter.acquire("c")).toBeNull();
    a!();
    a!(); // releasing twice is harmless
    expect(limiter.size).toBe(1);
    expect(limiter.acquire("c")).toBeTypeOf("function");
    b!();
  });
});

describe("createRunRateLimiter", () => {
  it("limits runs per setup session within the window", () => {
    let now = 0;
    const limiter = createRunRateLimiter(2, 1_000, () => now);
    expect(limiter.allow("s")).toBe(true);
    expect(limiter.allow("s")).toBe(true);
    expect(limiter.allow("s")).toBe(false);
    expect(limiter.allow("other")).toBe(true);
    now = 1_001;
    expect(limiter.allow("s")).toBe(true);
  });
});
