import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SERVER_UNAVAILABLE } from "@/lib/setup/database/localServer";
import { stampedHeaders } from "@/lib/setup/database/testRequests";
import { SETUP_SESSION_COOKIE, resetSetupSessionsForTests, startSetupSession } from "@/lib/setup/setupSession";

const mocks = vi.hoisted(() => ({ assertMode: vi.fn(async () => ({ mode: "setup" })) }));
vi.mock("@/lib/setup/mode", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/setup/mode")>()), assertMode: mocks.assertMode }));

const { POST } = await import("./route");

const headers = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http", "content-type": "application/json" };

beforeEach(() => {
  resetSetupSessionsForTests();
  mocks.assertMode.mockClear();
});

describe("POST /api/setup/database/local", () => {
  it("answers 501 with a plain message on a server that is not running the server image", async () => {
    const token = startSetupSession("loopback").token;
    const response = await POST(new Request("http://localhost:3000/api/setup/database/local", {
      method: "POST", headers: stampedHeaders({ ...headers, cookie: `${SETUP_SESSION_COOKIE}=${token}` }), body: JSON.stringify({ kind: "same-server" }),
    }));
    expect(response.status).toBe(501);
    expect((await response.json()).error).toBe(LOCAL_SERVER_UNAVAILABLE);
  });

  it("still applies the setup guards first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await POST(new Request("http://localhost:3000/api/setup/database/local", { method: "POST", headers: stampedHeaders({ ...headers, origin: "https://evil.example" }), body: "{}" }));
    expect(response.status).toBe(403);
    expect(mocks.assertMode).not.toHaveBeenCalled();
  });
});
