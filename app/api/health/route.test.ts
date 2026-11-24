import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveMode: vi.fn(async () => ({ mode: "setup" })) }));
vi.mock("@/lib/setup/mode", () => ({ resolveMode: mocks.resolveMode }));

const { GET } = await import("./route");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("reports the mode and the release this server runs", async () => {
    vi.stubEnv("POLYNOVEA_RELEASE_ID", "0.4.0+abc1234");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "setup", release: "0.4.0+abc1234" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports a null release outside a built image", async () => {
    vi.stubEnv("POLYNOVEA_RELEASE_ID", "");
    mocks.resolveMode.mockResolvedValueOnce({ mode: "running" });
    expect(await (await GET()).json()).toEqual({ state: "running", release: null });
  });

  it("never reports a malformed release value", async () => {
    vi.stubEnv("POLYNOVEA_RELEASE_ID", "<script>");
    expect((await (await GET()).json()).release).toBeNull();
  });
});
