import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDatabaseInput } from "@/lib/setup/database/checks";
import type { ManagedFlowContext } from "@/lib/setup/database/flow";
import type { ProvisionedDatabase } from "@/lib/setup/database/provision";
import { resetDatabaseStepLimitsForTests, SETUP_ALREADY_RUNNING } from "@/lib/setup/database/stream";
import { stampedHeaders } from "@/lib/setup/database/testRequests";
import { SETUP_SESSION_COOKIE, resetSetupSessionsForTests, startSetupSession } from "@/lib/setup/setupSession";

const mocks = vi.hoisted(() => ({
  assertMode: vi.fn(async () => ({ mode: "setup" })),
  reloadInstallConfig: vi.fn(),
  writeConfig: vi.fn(async () => {}),
  readInstallConfigSync: vi.fn((): unknown => null),
  runManaged: vi.fn(),
}));

vi.mock("@/lib/setup/mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/setup/mode")>()),
  assertMode: mocks.assertMode,
  reloadInstallConfig: mocks.reloadInstallConfig,
}));
vi.mock("@/lib/setup/configStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/setup/configStore")>()),
  writeConfig: mocks.writeConfig,
  readInstallConfigSync: mocks.readInstallConfigSync,
}));
vi.mock("@/lib/setup/database/flow", () => ({ runManagedDatabaseSetup: mocks.runManaged }));

const { ModeError } = await import("@/lib/setup/mode");
const { POST } = await import("./route");

const PASSWORD = "Adm1n-S3cret-Pa55word!";
const FORM = { hostname: "mydb.abc.eu-west-1.rds.amazonaws.com", port: 5432, database: "postgres", user: "dbadmin", password: PASSWORD };
const RESULT: ProvisionedDatabase = {
  databaseMode: "managed",
  database: { host: FORM.hostname, port: 5432, name: "postgres", caBundleId: "aws-rds-global-1" },
  roles: { owner: { user: "polynovea_owner", password: "o".repeat(43) }, app: { user: "polynovea_app", password: "a".repeat(43) } },
};

const tunnel = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http", "content-type": "application/json" };

function request(body: unknown, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...tunnel, ...options.headers };
  if (options.token) headers.cookie = `${SETUP_SESSION_COOKIE}=${options.token}`;
  return new Request("http://localhost:3000/api/setup/database/managed", { method: "POST", headers: stampedHeaders(headers), body: JSON.stringify(body) });
}

let token: string;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetSetupSessionsForTests();
  resetDatabaseStepLimitsForTests();
  token = startSetupSession("loopback").token;
  mocks.assertMode.mockClear();
  mocks.assertMode.mockImplementation(async () => ({ mode: "setup" }));
  mocks.writeConfig.mockClear();
  mocks.reloadInstallConfig.mockClear();
  mocks.readInstallConfigSync.mockImplementation(() => null);
  mocks.runManaged.mockReset();
  mocks.runManaged.mockImplementation(async (_input: ManagedDatabaseInput, context: ManagedFlowContext) => {
    context.emit({ type: "check", id: "dns", label: "Finding the database", status: "passed" });
    await context.saveConfig(RESULT);
    context.emit({ type: "done", databaseMode: "managed" });
    return RESULT;
  });
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/setup/database/managed", () => {
  it("refuses a request that fails the setup guards before reading the session or the mode", async () => {
    const response = await POST(request(FORM, { token, headers: { origin: "https://evil.example" } }));
    expect(response.status).toBe(403);
    expect(mocks.assertMode).not.toHaveBeenCalled();
    expect(mocks.runManaged).not.toHaveBeenCalled();
  });

  it("needs the setup session before the mode is checked", async () => {
    const response = await POST(request(FORM, { token: null }));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("SETUP_SESSION_REQUIRED");
    expect(mocks.assertMode).not.toHaveBeenCalled();
  });

  it("is a 404 once the install is finished", async () => {
    mocks.assertMode.mockImplementation(async () => { throw new ModeError("running", ["setup"]); });
    const response = await POST(request(FORM, { token }));
    expect(response.status).toBe(404);
    expect(mocks.runManaged).not.toHaveBeenCalled();
  });

  it("answers a bad form with a plain 400 that does not echo it", async () => {
    const response = await POST(request({ ...FORM, port: 99999 }, { token }));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("The port must be a whole number");
    expect(text).not.toContain(PASSWORD);
  });

  it("streams the run, saves config.enc once with a new auth secret, and reloads the mode check", async () => {
    const response = await POST(request(FORM, { token }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain('"type":"done"');
    expect(text).not.toContain(PASSWORD);
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1);
    const saved = (mocks.writeConfig.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(saved).toMatchObject({ v: 1, databaseMode: "managed", database: RESULT.database, roles: RESULT.roles, backupRepoPassword: null });
    expect(String(saved.authSecret).length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    expect(mocks.reloadInstallConfig).toHaveBeenCalledTimes(1);
    const input = mocks.runManaged.mock.calls[0][0] as ManagedDatabaseInput;
    expect(input).toMatchObject({ hostname: FORM.hostname, port: 5432, database: "postgres", user: "dbadmin" });
  });

  it("puts the saved auth secret into this process's environment when it is empty, never into an event", async () => {
    const before = process.env.POLYNOVEA_AUTH_SECRET;
    try {
      delete process.env.POLYNOVEA_AUTH_SECRET;
      const text = await (await POST(request(FORM, { token }))).text();
      const saved = ((mocks.writeConfig.mock.calls[0] as unknown[])[0] as { authSecret: string }).authSecret;
      expect(process.env.POLYNOVEA_AUTH_SECRET).toBe(saved);
      expect(text).not.toContain(saved);
      const logged = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]);
      expect(logged).not.toContain(saved);
    } finally {
      if (before === undefined) delete process.env.POLYNOVEA_AUTH_SECRET;
      else process.env.POLYNOVEA_AUTH_SECRET = before;
    }
  });

  it("leaves an auth secret the operator already set alone", async () => {
    const before = process.env.POLYNOVEA_AUTH_SECRET;
    try {
      process.env.POLYNOVEA_AUTH_SECRET = "operator-set-secret-".padEnd(40, "x");
      await (await POST(request(FORM, { token }))).text();
      expect(process.env.POLYNOVEA_AUTH_SECRET).toBe("operator-set-secret-".padEnd(40, "x"));
    } finally {
      if (before === undefined) delete process.env.POLYNOVEA_AUTH_SECRET;
      else process.env.POLYNOVEA_AUTH_SECRET = before;
    }
  });

  it("keeps the auth secret an earlier run saved", async () => {
    mocks.readInstallConfigSync.mockImplementation(() => ({ authSecret: "k".repeat(43) }));
    await (await POST(request(FORM, { token }))).text();
    expect(((mocks.writeConfig.mock.calls[0] as unknown[])[0] as { authSecret: string }).authSecret).toBe("k".repeat(43));
  });

  it("allows one run per install: a second POST, even from another browser, gets a plain 409", async () => {
    let finish!: () => void;
    mocks.runManaged.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = await POST(request(FORM, { token }));
    expect(first.status).toBe(200);

    const sameBrowser = await POST(request(FORM, { token }));
    expect(sameBrowser.status).toBe(409);
    expect(await sameBrowser.json()).toMatchObject({ error: SETUP_ALREADY_RUNNING, code: "SETUP_DATABASE_RUNNING" });

    const otherToken = startSetupSession("loopback").token; // another browser enters the code
    const otherBrowser = await POST(request(FORM, { token: otherToken }));
    expect(otherBrowser.status).toBe(409);
    expect(mocks.runManaged).toHaveBeenCalledTimes(1);

    finish();
    await first.text();
    const after = await POST(request(FORM, { token: otherToken }));
    expect(after.status).toBe(200);
    finish();
    await after.text();
  });

  it("limits how many runs one setup session may start", async () => {
    for (let i = 0; i < 10; i += 1) await (await POST(request(FORM, { token }))).text();
    const eleventh = await POST(request(FORM, { token }));
    expect(eleventh.status).toBe(429);
    expect((await eleventh.json()).code).toBe("SETUP_DATABASE_RATE_LIMITED");
  });
});
