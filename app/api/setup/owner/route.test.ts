import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_SESSION_COOKIE, resetSetupSessionsForTests, startSetupSession } from "@/lib/setup/setupSession";
import { readEnrolment } from "@/lib/setup/owner/enrolment";

// The owner step's routes run guardSetupRequest, assertMode("setup") and requireSetupSession, in
// that order, before any action. The mode is driven by the test; everything else is real.
const mode = vi.hoisted(() => ({ value: "setup" as "setup" | "running" | "unavailable" }));
vi.mock("@/lib/setup/mode", async () => {
  const actual = await vi.importActual<typeof import("@/lib/setup/mode")>("@/lib/setup/mode");
  return {
    ...actual,
    assertMode: async (expected: string) => {
      if (mode.value !== expected) throw new actual.ModeError(mode.value, [expected as "setup"]);
      return { mode: mode.value };
    },
  };
});

const { POST } = await import("./[action]/route");
const { GET } = await import("./route");

const ORIGIN = "http://localhost:3000";
const savedEnv = { ...process.env };
let token: string;

function request(action: string, body: unknown = {}, headers: Record<string, string> = {}, method = "POST") {
  return new Request(`${ORIGIN}/api/setup/owner${action ? `/${action}` : ""}`, {
    method,
    headers: {
      host: "localhost:3000",
      origin: ORIGIN,
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "http",
      "content-type": "application/json",
      cookie: `${SETUP_SESSION_COOKIE}=${token}`,
      ...headers,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}
const params = (action: string) => ({ params: Promise.resolve({ action }) });

beforeEach(() => {
  mode.value = "setup";
  Object.assign(process.env, { POLYNOVEA_HIBP_DISABLED: "true", POLYNOVEA_PUBLIC_URL: ORIGIN });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetSetupSessionsForTests();
  token = startSetupSession("loopback").token;
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("owner step routes", () => {
  it("stage the account behind every check, with the setup headers, and never echo the password", async () => {
    const password = "a long owner passphrase 42";
    const response = await POST(request("account", { email: "owner@example.test", displayName: "Owner", password }), params("account"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ success: true, data: { email: "owner@example.test", displayName: "Owner" } });
    expect(text).not.toContain(password);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuse a request from another origin before looking at the session or the body", async () => {
    const response = await POST(request("account", { email: "x@example.test" }, { origin: "https://evil.example.test" }), params("account"));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("SETUP_REQUEST_REFUSED");
  });

  it("answer 404 on a finished install and 503 while the database is down", async () => {
    mode.value = "running";
    expect((await POST(request("account"), params("account"))).status).toBe(404);
    expect((await GET(request("", undefined, {}, "GET"))).status).toBe(404);
    mode.value = "unavailable";
    expect((await POST(request("account"), params("account"))).status).toBe(503);
  });

  it("need the setup session", async () => {
    const response = await POST(request("account", {}, { cookie: "" }), params("account"));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SETUP_SESSION_REQUIRED");
  });

  it("refuse unknown actions, unreadable bodies, and steps out of order", async () => {
    expect((await POST(request("constructor"), params("constructor"))).status).toBe(404);
    const bad = new Request(`${ORIGIN}/api/setup/owner/account`, { method: "POST", headers: { ...Object.fromEntries(request("account").headers), "content-type": "text/plain" }, body: "x" });
    expect((await POST(bad, params("account"))).status).toBe(400);
    const early = await POST(request("totp-start"), params("totp-start"));
    expect(early.status).toBe(409);
    expect((await early.json()).code).toBe("ACCOUNT_FIRST");
    const finish = await POST(request("finish"), params("finish"));
    expect(finish.status).toBe(409);
    expect((await finish.json()).code).toBe("STEP_MISSING");
  });

  it("the summary shows progress and the temporary-route warning, never a secret", async () => {
    await POST(request("account", { email: "owner@example.test", displayName: "Owner", password: "a long owner passphrase 42" }), params("account"));
    const started = await (await POST(request("totp-start"), params("totp-start"))).json();
    expect(started.data.totpURI).toMatch(/^otpauth:\/\/totp\//);
    const response = await GET(request("", undefined, {}, "GET"));
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.data).toMatchObject({ email: "owner@example.test", temporaryRoute: true, steps: { account: true, authenticator: false } });
    expect(body.data.temporaryRouteWarning).toContain("Your passkey only works on this address.");
    const session = startSetupSession("loopback"); // takeover keeps the state
    const secret = readEnrolment(session.session).totp!.secret;
    expect(text).not.toContain(secret);
    expect(text).not.toContain("$argon2id$");
  });
});
