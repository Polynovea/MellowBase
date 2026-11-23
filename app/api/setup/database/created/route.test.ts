import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_CREATED_FOR_YOU } from "@/lib/setup/database/createdForYou";
import { resetDatabaseStepLimitsForTests } from "@/lib/setup/database/stream";
import { SETUP_SESSION_COOKIE, resetSetupSessionsForTests, startSetupSession } from "@/lib/setup/setupSession";

const mocks = vi.hoisted(() => ({ assertMode: vi.fn(async () => ({ mode: "setup" })), runCreated: vi.fn() }));
vi.mock("@/lib/setup/mode", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/setup/mode")>()), assertMode: mocks.assertMode }));
vi.mock("@/lib/setup/database/createdForYou", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/setup/database/createdForYou")>()),
  runCreatedForYouSetup: mocks.runCreated,
}));

const { POST } = await import("./route");

const headers = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" };
const post = (token: string) => new Request("http://localhost:3000/api/setup/database/created", { method: "POST", headers: { ...headers, cookie: `${SETUP_SESSION_COOKIE}=${token}` } });

const saved = process.env.POLYNOVEA_DB_SECRET_REF;
beforeEach(() => {
  resetSetupSessionsForTests();
  resetDatabaseStepLimitsForTests();
  mocks.runCreated.mockReset();
  mocks.runCreated.mockImplementation(async (context: { emit: (event: unknown) => void }) => context.emit({ type: "done", databaseMode: "created" }));
});
afterEach(() => {
  if (saved === undefined) delete process.env.POLYNOVEA_DB_SECRET_REF;
  else process.env.POLYNOVEA_DB_SECRET_REF = saved;
});

describe("POST /api/setup/database/created", () => {
  it("says plainly when this server was not made by a template", async () => {
    delete process.env.POLYNOVEA_DB_SECRET_REF;
    const response = await POST(post(startSetupSession("loopback").token));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(NOT_CREATED_FOR_YOU);
    expect(mocks.runCreated).not.toHaveBeenCalled();
  });

  it("reads the operator's secret reference and streams the run", async () => {
    process.env.POLYNOVEA_DB_SECRET_REF = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:polynovea/db-AbCdEf";
    const response = await POST(post(startSetupSession("loopback").token));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"databaseMode":"created"');
    expect(mocks.runCreated.mock.calls[0][0]).toMatchObject({ secretRef: { kind: "aws", region: "eu-west-1" } });
  });
});
