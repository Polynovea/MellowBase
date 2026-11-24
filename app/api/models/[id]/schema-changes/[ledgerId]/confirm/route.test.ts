import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.fn();
vi.mock("@/lib/platform/permissions", () => ({ requirePlatformAccess: (...args: unknown[]) => access(...args) }));
vi.mock("@/lib/schema/modelService", () => ({
  getModel: vi.fn(async () => ({ id: "m1", workspace_id: "ws", name: "Card", api_key: "card", current_schema_version: 2 })),
  getVersion: vi.fn(async () => ({ schema_json: { name: "Card", apiKey: "card", fields: [] } })),
}));
const stage = { value: { id: "11111111-1111-4111-8111-111111111111", stage: "destructive", status: "awaiting_confirmation" } as Record<string, string> | undefined };
vi.mock("@/lib/db/index", () => ({
  getDb: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["selectFrom", "select", "where"]) chain[method] = () => chain;
    chain.executeTakeFirst = async () => stage.value;
    return chain;
  },
}));
const confirm = vi.fn();
vi.mock("@/lib/schema/runner/request", () => ({ confirmPlanStage: (...args: unknown[]) => confirm(...args) }));
const audit = vi.fn();
vi.mock("@/lib/platform/audit", () => ({ logPlatformEvent: (...args: unknown[]) => audit(...args) }));
vi.mock("@/lib/schema/schemaChanges", () => ({ modelSchemaChanges: vi.fn(async () => []) }));

import { POST } from "./route";

const LEDGER = "11111111-1111-4111-8111-111111111111";
const call = (body: unknown) => POST(new Request("https://cms.example.test/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "m1", ledgerId: LEDGER }) });

describe("confirming a model's waiting deletion", () => {
  beforeEach(() => {
    access.mockReset().mockResolvedValue({ data: { actor: { workspaceId: "ws", adminUserId: "admin-1" } } });
    confirm.mockReset().mockResolvedValue(undefined);
    audit.mockReset();
    stage.value = { id: LEDGER, stage: "destructive", status: "awaiting_confirmation" };
  });

  it("needs the model-editing permission with a recent sign-in", async () => {
    await call({ typedApiKey: "card" });
    expect(access).toHaveBeenCalledWith(expect.anything(), { permission: "schema.manage", stepUp: true });
    access.mockResolvedValueOnce({ error: new Response(null, { status: 403 }) });
    expect((await call({ typedApiKey: "card" })).status).toBe(403);
  });

  it("confirms with the typed api key and audits it", async () => {
    const response = await call({ typedApiKey: " card " });
    expect(response.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(expect.anything(), { ledgerId: LEDGER, confirmedBy: "admin-1", typedApiKey: "card" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "schema.migration.confirmed", entityId: "m1", metadata: { ledgerId: LEDGER, stage: "destructive" } }));
  });

  it("a wrong key deletes nothing and is not audited as confirmed", async () => {
    confirm.mockRejectedValueOnce(Object.assign(new Error("schema_confirmation_mismatch"), { code: "22023" }));
    const response = await call({ typedApiKey: "nope" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Nothing was deleted/);
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a missing key, a change that is not waiting, and an unknown change", async () => {
    expect((await call({})).status).toBe(400);
    stage.value = { id: LEDGER, stage: "expand", status: "pending" };
    expect((await call({ typedApiKey: "card" })).status).toBe(409);
    stage.value = undefined;
    expect((await call({ typedApiKey: "card" })).status).toBe(404);
    expect(confirm).not.toHaveBeenCalled();
  });
});
