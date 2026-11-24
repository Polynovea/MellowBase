import { beforeEach, describe, expect, it, vi } from "vitest";

// The service's own rules (validation, capability projection, change classification) run here; the
// database writes are faked at the PostgreSQL model module. The writes themselves, including the 409
// for a duplicate apiKey, are covered by modelService.dual.test.ts.
// (Mocked outright: the PostgreSQL module imports from modelService.ts, so importOriginal would loop.)
vi.mock("@/lib/schema/modelService.postgres", () => ({
  createModelRecord: vi.fn(),
  applySchemaVersion: vi.fn(),
  getVersion: vi.fn(),
  rebuildContentFields: vi.fn(),
  getModel: vi.fn(),
  listModels: vi.fn(),
  listVersions: vi.fn(),
  updateModelMetadata: vi.fn(),
}));
vi.mock("@/lib/platform/audit", () => ({
  logPlatformEvent: vi.fn(),
}));
// Phase 4: the write and its schema change run in one transaction (faked: the callback gets a marker).
const TRX = { trx: true };
vi.mock("@/lib/db/index", () => ({ withTransaction: vi.fn(async (fn: (trx: unknown) => unknown) => fn(TRX)) }));
vi.mock("@/lib/schema/runner/request", () => ({ requestSchemaChange: vi.fn(async () => ({ plan: { steps: [] }, expandLedgerId: "ledger-expand", destructiveLedgerId: null })) }));
// Audit events of a model write are recorded in its transaction.
vi.mock("@/lib/platform/audit.postgres", () => ({ recordPlatformEvent: vi.fn() }));

import { logPlatformEvent } from "@/lib/platform/audit";
import * as records from "@/lib/schema/modelService.postgres";
import { applyChange, createModel, type ContentModelRow, type ContentModelVersionRow } from "@/lib/schema/modelService";
import { requestSchemaChange } from "@/lib/schema/runner/request";
import { SchemaEngineError } from "@/lib/schema/engine/errors";

const mockLogPlatformEvent = vi.mocked(logPlatformEvent);
const createModelRecord = vi.mocked(records.createModelRecord);
const applySchemaVersion = vi.mocked(records.applySchemaVersion);
const getVersion = vi.mocked(records.getVersion);

const validSchema = {
  name: "Blog Post",
  apiKey: "blog_post",
  fields: [{ key: "title", label: "Title", type: "text", required: true }],
};

const modelRow: ContentModelRow = {
  id: "model-1",
  workspace_id: "ws-1",
  name: "Blog Post",
  api_key: "blog_post",
  description: null,
  icon: null,
  status: "active",
  current_schema_version: 1,
  settings_json: { capability: "content_enabled" },
  created_by: "admin-1",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const versionRow: ContentModelVersionRow = {
  id: "version-1",
  content_model_id: "model-1",
  version_number: 1,
  schema_json: validSchema as never,
  schema_hash: "abc",
  change_summary: "Initial version",
  created_by: "admin-1",
  created_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  mockLogPlatformEvent.mockReset();
  createModelRecord.mockReset();
  applySchemaVersion.mockReset();
  getVersion.mockReset();
});

describe("createModel", () => {
  it("rejects a structurally invalid schema before touching the database", async () => {
    const result = await createModel({
      workspaceId: "ws-1",
      proposedSchema: { name: "Bad", apiKey: "Bad Key!", fields: [] },
      createdBy: "admin-1",
    });
    expect(result.ok).toBe(false);
    expect(createModelRecord).not.toHaveBeenCalled();
  });

  it("creates the model, its first version, and rebuilds content_fields on success", async () => {
    createModelRecord.mockResolvedValue({ ok: true, data: { model: modelRow, version: versionRow } });

    const result = await createModel({ workspaceId: "ws-1", proposedSchema: validSchema, createdBy: "admin-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.model.api_key).toBe("blog_post");
      expect(result.data.version.version_number).toBe(1);
    }
    expect(createModelRecord).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      actorId: "admin-1",
      schema: expect.objectContaining({ apiKey: "blog_post" }),
    }));
  });

  it("projects the schema's capability into settings_json on insert", async () => {
    createModelRecord.mockResolvedValue({ ok: true, data: { model: { ...modelRow, settings_json: { capability: "data_only" } }, version: versionRow } });

    const dataOnlySchema = { ...validSchema, apiKey: "customer", capability: "data_only" as const };
    await createModel({ workspaceId: "ws-1", proposedSchema: dataOnlySchema, createdBy: "admin-1" });

    expect(createModelRecord).toHaveBeenCalledWith(expect.objectContaining({ capability: "data_only" }));
  });

  it("rejects a data_only model that grants a publish permission", async () => {
    const result = await createModel({
      workspaceId: "ws-1",
      proposedSchema: { ...validSchema, capability: "data_only", permissions: [{ role: "editor", operations: ["publish"] }] },
      createdBy: "admin-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/publish/i);
    expect(createModelRecord).not.toHaveBeenCalled();
  });
});

describe("applyChange", () => {
  it("does not create a duplicate immutable version when the reviewed schema is unchanged", async () => {
    getVersion.mockResolvedValue(versionRow);

    const result = await applyChange({ model: modelRow, proposedSchema: validSchema, acknowledgeUnsafe: true, actorAdminUserId: "admin-1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ applied: false, noChanges: true, blockedReason: "No schema changes to apply" });
    expect(applySchemaVersion).not.toHaveBeenCalled();
    expect(mockLogPlatformEvent).not.toHaveBeenCalled();
  });

  it("blocks a destructive change and does not write a new version when acknowledgeUnsafe is not set", async () => {
    getVersion.mockResolvedValue({
      ...versionRow,
      schema_json: { name: "Blog Post", apiKey: "blog_post", fields: [{ key: "title", label: "Title", type: "text", required: false }] } as never,
    });

    const result = await applyChange({
      model: modelRow,
      proposedSchema: { name: "Blog Post", apiKey: "blog_post", fields: [] }, // removing the only field -> DESTRUCTIVE
      acknowledgeUnsafe: false,
      actorAdminUserId: "admin-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.applied).toBe(false);
      expect(result.data.diff.overallClassification).toBe("DESTRUCTIVE");
    }
    // Only the read of the current version happened: no version write, no field rebuild.
    expect(applySchemaVersion).not.toHaveBeenCalled();
  });

  it("applies a destructive change when acknowledgeUnsafe is true", async () => {
    getVersion.mockResolvedValue({
      ...versionRow,
      schema_json: { name: "Blog Post", apiKey: "blog_post", fields: [{ key: "title", label: "Title", type: "text", required: false }] } as never,
    });
    applySchemaVersion.mockResolvedValue({ ok: true, version: { ...versionRow, version_number: 2 } } as never);

    const result = await applyChange({
      model: modelRow,
      proposedSchema: { name: "Blog Post", apiKey: "blog_post", fields: [] },
      acknowledgeUnsafe: true,
      actorAdminUserId: "admin-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.applied).toBe(true);
      expect(result.data.version?.version_number).toBe(2);
    }
    expect(applySchemaVersion).toHaveBeenCalledWith(expect.objectContaining({ model: expect.objectContaining({ id: "model-1" }) }));
  });

  it("saves a label-only change as a new version (it is not a data change, but it is a change)", async () => {
    getVersion.mockResolvedValue(versionRow);
    applySchemaVersion.mockResolvedValue({ ok: true, version: { ...versionRow, version_number: 2 } } as never);

    const result = await applyChange({
      model: modelRow,
      proposedSchema: { ...validSchema, fields: [{ key: "title", label: "Headline", type: "text", required: true }] },
      acknowledgeUnsafe: false,
      actorAdminUserId: "admin-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.diff.entries).toEqual([]);
      expect(result.data.applied).toBe(true);
      expect(result.data.version?.version_number).toBe(2);
    }
    expect(applySchemaVersion).toHaveBeenCalled();
  });

  it("rejects a change that alters apiKey", async () => {
    getVersion.mockResolvedValue({ ...versionRow });

    const result = await applyChange({
      model: modelRow,
      proposedSchema: { ...validSchema, apiKey: "renamed_key" },
      acknowledgeUnsafe: true,
      actorAdminUserId: "admin-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/apiKey/i);
    expect(applySchemaVersion).not.toHaveBeenCalled();
  });
});

describe("Phase 4: every model write queues its schema change in the same transaction", () => {
  const request = vi.mocked(requestSchemaChange);
  beforeEach(() => {
    request.mockClear();
    createModelRecord.mockReset();
    createModelRecord.mockResolvedValue({ ok: true, data: { model: { id: "model-1" } as ContentModelRow, version: { id: "version-1" } as ContentModelVersionRow } });
  });

  it("createModel writes through the transaction and queues the table for that version", async () => {
    const result = await createModel({ workspaceId: "ws", createdBy: "admin", proposedSchema: validSchema });
    expect(result).toMatchObject({ ok: true, data: { schemaChange: { expandLedgerId: "ledger-expand", destructiveLedgerId: null } } });
    expect(createModelRecord.mock.calls[0][0]).toMatchObject({ db: TRX });
    expect(request).toHaveBeenCalledWith(TRX, expect.objectContaining({ contentModelId: "model-1", targetVersionId: "version-1", requestedBy: "admin" }));
  });

  it("a refusal from the schema engine is the write's error (the transaction rolls the version back)", async () => {
    request.mockRejectedValueOnce(new SchemaEngineError("cap_exceeded", "This install already has the most models it allows."));
    const result = await createModel({ workspaceId: "ws", createdBy: "admin", proposedSchema: validSchema });
    expect(result).toEqual({ ok: false, error: "This install already has the most models it allows.", status: 409 });
  });

  it("a failed model write queues nothing", async () => {
    createModelRecord.mockResolvedValueOnce({ ok: false, error: "An active model already uses this apiKey", status: 409 });
    const result = await createModel({ workspaceId: "ws", createdBy: "admin", proposedSchema: validSchema });
    expect(result).toEqual({ ok: false, error: "An active model already uses this apiKey", status: 409 });
    expect(request).not.toHaveBeenCalled();
  });
});
