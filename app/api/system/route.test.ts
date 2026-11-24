import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ calls: [] as unknown[], result: { data: { actor: { adminUserId: "admin-1", workspaceId: "w" } } } as Record<string, unknown> }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async (_req: Request, options: unknown) => {
    access.calls.push(options);
    return access.result;
  }),
}));
const startUpgrade = vi.hoisted(() => vi.fn(async () => ({ requestId: "r", releaseId: "0.4.1+b", rollback: "compatible" })));
vi.mock("@/lib/system/upgradeRequest", () => ({
  startUpgrade,
  ingestAgentStatus: vi.fn(async () => null),
  upgradeAgentPresent: vi.fn(async () => true),
  UpgradeRequestError: class extends Error {},
}));
vi.mock("@/lib/system/systemData", () => ({ listRestoreTests: vi.fn(async () => []), listUpgrades: vi.fn(async () => []), UpgradeInProgressError: class extends Error {} }));
vi.mock("@/lib/system/systemProbes", () => ({ runSystemChecks: vi.fn(async () => []) }));
vi.mock("@/lib/system/releaseChannel", () => ({ checkForRelease: vi.fn(async () => null) }));

const { POST } = await import("./route");
const post = (body: unknown) => POST(new Request("http://localhost/api/system", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  access.calls = [];
  access.result = { data: { actor: { adminUserId: "admin-1", workspaceId: "w" } } };
  startUpgrade.mockClear();
});

describe("POST /api/system (upgrade)", () => {
  it("requires infrastructure.upgrade with step-up (a fresh second factor)", async () => {
    const response = await post({ operation: "upgrade", releaseId: "0.4.1+b" });
    expect(response.status).toBe(202);
    expect(access.calls).toEqual([{ permission: "infrastructure.upgrade", stepUp: true }]);
    expect(startUpgrade).toHaveBeenCalledOnce();
  });

  it("starts nothing when step-up is required", async () => {
    access.result = { error: Response.json({ error: "STEP_UP_REQUIRED" }, { status: 403 }) };
    const response = await post({ operation: "upgrade", releaseId: "0.4.1+b" });
    expect(response.status).toBe(403);
    expect(startUpgrade).not.toHaveBeenCalled();
  });
});
