import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_MS, MAX_WRONG_ATTEMPTS, resetAttemptLimiterForTests } from "@/lib/setup/attemptLimiter";
import { issueSetupCode, resetSetupCodeForTests } from "@/lib/setup/setupCode";
import { SETUP_SESSION_COOKIE, requireSetupSession, resetSetupSessionsForTests } from "@/lib/setup/setupSession";
import { POST } from "./route";

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

const tunnelHeaders = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-proto": "http",
  "content-type": "application/json",
};

function post(body: unknown, headers: Record<string, string> = tunnelHeaders, url = "http://localhost:3000/api/setup/code") {
  return new Request(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function cookieToken(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SETUP_SESSION_COOKIE}=([^;]+)`).exec(header);
  if (!match) throw new Error("no setup cookie");
  return match[1];
}

let code: string;

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetSetupCodeForTests();
  resetAttemptLimiterForTests();
  resetSetupSessionsForTests();
  code = issueSetupCode({ env: {}, now: T0 }).display!;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/setup/code", () => {
  it("a right code starts the setup session and sets the __Host- cookie", async () => {
    const response = await POST(post({ code }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { next: "/setup/database", tookOver: false } });
    const setCookie = response.headers.get("set-cookie")!;
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=3600"]) expect(setCookie).toContain(part);
    const session = requireSetupSession({ headers: new Headers({ cookie: `${SETUP_SESSION_COOKIE}=${cookieToken(response)}` }) });
    expect(session.transport).toBe("loopback");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("a wrong code is a plain 401 and sets no cookie", async () => {
    const response = await POST(post({ code: "0000-0000" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({ success: false, code: "SETUP_CODE_WRONG" });
    expect(JSON.stringify(body)).not.toContain(code);
  });

  it("the code is never logged", async () => {
    await POST(post({ code }));
    await POST(post({ code: "WRONG" }));
    const logged = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.info).mock.calls].flat().join("\n");
    expect(logged).not.toContain(code);
    expect(logged).not.toContain("WRONG");
  });

  it("acceptance test 2: five wrong codes lock; the right code is refused during the lock and works after it", async () => {
    for (let i = 1; i < MAX_WRONG_ATTEMPTS; i += 1) expect((await POST(post({ code: `wrong-${i}` }))).status).toBe(401);
    const fifth = await POST(post({ code: "wrong-5" }));
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("retry-after")).toBe(String(LOCK_MS / 1000));
    expect((await fifth.json()).code).toBe("SETUP_LOCKED");

    const duringLock = await POST(post({ code }));
    expect(duringLock.status).toBe(429);
    expect(duringLock.headers.get("set-cookie")).toBeNull();

    vi.setSystemTime(T0 + LOCK_MS + 1000);
    // The code itself is still inside its hour.
    const afterLock = await POST(post({ code }));
    expect(afterLock.status).toBe(200);
  });

  it("a second browser entering the code takes over", async () => {
    const first = cookieToken(await POST(post({ code })));
    const secondResponse = await POST(post({ code }));
    expect((await secondResponse.json()).data.tookOver).toBe(true);
    expect(() => requireSetupSession({ headers: new Headers({ cookie: `${SETUP_SESSION_COOKIE}=${first}` }) })).toThrow("Setup continued in another browser.");
  });

  it("an expired code is refused like a wrong one", async () => {
    vi.setSystemTime(T0 + 60 * 60 * 1000);
    const response = await POST(post({ code }));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SETUP_CODE_WRONG");
  });

  it("refuses the code in the query string before reading or counting anything", async () => {
    const response = await POST(post({ code }, tunnelHeaders, `http://localhost:3000/api/setup/code?code=${code}`));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses plain HTTP from a remote address and a foreign Origin", async () => {
    const remote = { ...tunnelHeaders, host: "203.0.113.5:3000", origin: "http://203.0.113.5:3000", "x-forwarded-for": "198.51.100.7" };
    expect((await POST(post({ code }, remote))).status).toBe(403);
    expect((await POST(post({ code }, { ...tunnelHeaders, origin: "http://evil.localhost:3000" }))).status).toBe(403);
  });

  it("guard refusals do not count as wrong codes", async () => {
    const foreign = { ...tunnelHeaders, origin: "https://evil.example" };
    for (let i = 0; i < MAX_WRONG_ATTEMPTS + 2; i += 1) await POST(post({ code: "nope" }, foreign));
    expect((await POST(post({ code }))).status).toBe(200);
  });

  it("refuses bodies that are not a JSON {code}, without counting them", async () => {
    expect((await POST(post("code=abc", { ...tunnelHeaders, "content-type": "application/x-www-form-urlencoded" }))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ code: 123 }))).status).toBe(400);
    expect((await POST(post({ code: "x".repeat(5000) }))).status).toBe(400);
    for (let i = 0; i < MAX_WRONG_ATTEMPTS; i += 1) await POST(post("{}"));
    expect((await POST(post({ code }))).status).toBe(200);
  });
});
