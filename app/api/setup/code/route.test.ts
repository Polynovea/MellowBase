import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_MS, MAX_WRONG_ATTEMPTS, resetAttemptLimiterForTests } from "@/lib/setup/attemptLimiter";
import { ModeError, assertMode } from "@/lib/setup/mode";
import { peerStampEntryForTests, type PeerInfo } from "@/lib/setup/peerStamp";
import { issueSetupCode, resetSetupCodeForTests, setupCodeExpiresAt } from "@/lib/setup/setupCode";
import { SETUP_SESSION_COOKIE, requireSetupSession, resetSetupSessionsForTests } from "@/lib/setup/setupSession";
import { POST } from "./route";

vi.mock("@/lib/setup/mode", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/setup/mode")>()), assertMode: vi.fn() }));

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

/** A browser through an SSH tunnel to a server bound to 127.0.0.1 (as Next.js and the stamp present it). */
const TUNNEL: PeerInfo = { peer: "127.0.0.1", bound: "127.0.0.1", tls: false, forwarded: false };
const tunnelHeaders: Record<string, string> = {
  host: "localhost:3000",
  origin: "http://localhost:3000",
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-proto": "http",
  "content-type": "application/json",
};

function post(body: unknown, headers: Record<string, string> = tunnelHeaders, url = "http://localhost:3000/api/setup/code", conn: PeerInfo = TUNNEL) {
  const all = new Headers(headers);
  all.set(...peerStampEntryForTests(conn));
  return new Request(url, { method: "POST", headers: all, body: typeof body === "string" ? body : JSON.stringify(body) });
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
  vi.mocked(assertMode).mockResolvedValue({ mode: "setup", databaseSource: null, databaseReady: false, reason: "", checkedAt: T0 });
});

/** The replacement code the route printed after the last successful use. */
function printedReplacement(): string {
  const line = vi.mocked(console.info).mock.calls.flat().map(String).reverse().find((l) => l.includes("use this new code"));
  const match = line && /new code: ([0-9A-Z-]+)/.exec(line);
  if (!match) throw new Error("no replacement code printed");
  return match[1];
}

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

  it("the code works once: a second use fails even inside the hour", async () => {
    expect((await POST(post({ code }))).status).toBe(200);
    const again = await POST(post({ code }));
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("after a use, a replacement code is printed to the log, and it is what takes setup over to another browser", async () => {
    const first = cookieToken(await POST(post({ code })));
    const replacement = printedReplacement();
    expect(replacement).not.toBe(code);
    const secondResponse = await POST(post({ code: replacement }));
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

  it("on a finished install it is a 404 and never touches the code", async () => {
    vi.mocked(assertMode).mockRejectedValueOnce(new ModeError("running", ["setup"]));
    const response = await POST(post({ code }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(setupCodeExpiresAt()).not.toBeNull();
    expect((await POST(post({ code }))).status).toBe(200);
  });

  it("refuses a spoofed loopback: XFF 127.0.0.1 and Host localhost from a remote peer", async () => {
    const spoof = { peer: "198.51.100.7", bound: "0.0.0.0", tls: false, forwarded: true };
    expect((await POST(post({ code }, tunnelHeaders, undefined, spoof))).status).toBe(403);
  });

  it("refuses the tunnel when the server listens on every interface", async () => {
    expect((await POST(post({ code }, tunnelHeaders, undefined, { ...TUNNEL, bound: "0.0.0.0" }))).status).toBe(403);
  });

  it("refuses a request without the peer stamp", async () => {
    const bare = new Request("http://localhost:3000/api/setup/code", { method: "POST", headers: tunnelHeaders, body: JSON.stringify({ code }) });
    expect((await POST(bare)).status).toBe(403);
  });

  it("rotating X-Forwarded-For values from one peer cannot escape the lockout", async () => {
    // Forwarding headers make the tunnel ineligible, so use HTTPS on the socket to reach the limiter.
    const direct = { peer: "198.51.100.7", bound: "0.0.0.0", tls: true, forwarded: true };
    const https = { ...tunnelHeaders, host: "cms.example.com", origin: "https://cms.example.com" };
    for (let i = 0; i < MAX_WRONG_ATTEMPTS; i += 1) {
      await POST(post({ code: `wrong-${i}` }, { ...https, "x-forwarded-for": `192.0.2.${i}` }, "https://cms.example.com/api/setup/code", direct));
    }
    const locked = await POST(post({ code }, { ...https, "x-forwarded-for": "192.0.2.200" }, "https://cms.example.com/api/setup/code", direct));
    expect(locked.status).toBe(429);
  });

  it("refuses plain HTTP from a remote address and a foreign Origin", async () => {
    const remote = { ...tunnelHeaders, host: "203.0.113.5:3000", origin: "http://203.0.113.5:3000" };
    expect((await POST(post({ code }, remote, undefined, { peer: "198.51.100.7", bound: "0.0.0.0", tls: false, forwarded: false }))).status).toBe(403);
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
