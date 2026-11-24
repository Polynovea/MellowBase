// Phase 4: saving a model in the CMS queues its schema change in the same transaction, and the
// schema worker applies it (Phase 3 built the runner; nothing called it outside content:move).
import { afterAll, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { getDb } from "@/lib/db/index";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { applyChange, createModel, getModel } from "@/lib/schema/modelService";
import { closeTableMoveSession, runWorker } from "@/lib/content/testing/tableMove";
import { tableSource } from "@/lib/content/tableStore";
import { modelSchemaChanges } from "@/lib/schema/schemaChanges";
import { confirmPlanStage } from "@/lib/schema/runner/request";
import { createEntry } from "@/lib/content/entryService";
import type { FieldDefinition } from "@/lib/schema/fields/types";

const f = (key: string, type: FieldDefinition["type"] = "text", extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key, type, required: false, localized: false, unique: false, ...extra } as FieldDefinition);

async function workspace(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
  return { workspaceId, adminUserId };
}

const ledger = (backend: BackendFixtures, modelId: string) =>
  backend.query<{ stage: string; status: string }>("select stage, status from schema_migration_ledger where content_model_id = $1 order by created_at, stage", [modelId]);
const columns = async (backend: BackendFixtures, modelId: string) => {
  const [table] = await backend.query<{ table_name: string }>("select table_name from content_model_tables where content_model_id = $1", [modelId]);
  if (!table) return null;
  const rows = await backend.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'content' and table_name = $1 order by column_name", [table.table_name]);
  return rows.map((row) => row.column_name);
};

describeWithDatabase("model saves queue their schema change [postgres]", (backend) => {
  afterAll(async () => { await closeTableMoveSession(); });

  it("a new model gets its table automatically (no content:move)", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Note", apiKey: uniqueKey("note"), fields: [f("title")] } });
    if (!created.ok) throw new Error(created.error);
    expect(created.data.schemaChange.expandLedgerId).toBeTruthy();
    const modelId = created.data.model.id;
    expect(await ledger(backend, modelId)).toEqual([{ stage: "expand", status: "pending" }]);
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await columns(backend, modelId)).toEqual(expect.arrayContaining(["title"]));
    // A new model has nothing to copy: the worker verified it and switched its reads to the table.
    expect(await tableSource(workspaceId, modelId)).not.toBeNull();
  });

  it("a model with entries is never switched by the worker (moving content stays content:move)", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Old", apiKey: uniqueKey("old"), fields: [f("title")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    const entry = await createEntry({ workspaceId, modelId, data: { title: "Existing" }, actorAdminUserId: adminUserId });
    if (!entry.ok) throw new Error(entry.error);
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await tableSource(workspaceId, modelId)).toBeNull();
  });

  it("adding a field reaches succeeded and the table serves it", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const apiKey = uniqueKey("post");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Post", apiKey, fields: [f("title")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await tableSource(workspaceId, modelId)).not.toBeNull(); // adopted by the worker

    const changed = await applyChange({ model: (await getModel(workspaceId, modelId))!, proposedSchema: { name: "Post", apiKey, fields: [f("title"), f("subtitle")] }, acknowledgeUnsafe: false, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.applied) throw new Error("change not applied");
    expect(changed.data.schemaChange?.expandLedgerId).toBeTruthy();
    // While the change waits for the worker, reads stay on the snapshots.
    expect(await tableSource(workspaceId, modelId)).toBeNull();
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    const source = await tableSource(workspaceId, modelId);
    expect(source).not.toBeNull();
    expect(Object.values(source!.shape.columns).map((column) => column.field)).toEqual(expect.arrayContaining(["title", "subtitle"]));
  });

  it("a destructive change waits for confirmation and nothing is dropped", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const apiKey = uniqueKey("card");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Card", apiKey, fields: [f("title"), f("body", "long_text")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    await runWorker(modelId);
    const changed = await applyChange({ model: (await getModel(workspaceId, modelId))!, proposedSchema: { name: "Card", apiKey, fields: [f("title")] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.applied) throw new Error("change not applied");
    expect(changed.data.schemaChange?.destructiveLedgerId).toBeTruthy();
    await runWorker(modelId);
    const rows = await ledger(backend, modelId);
    expect(rows.at(-1)).toEqual({ stage: "destructive", status: "awaiting_confirmation" });
    expect(await columns(backend, modelId)).toEqual(expect.arrayContaining(["title", "body"]));

    // The model response's view: the deletion in plain words, with the values it would delete.
    const model = (await getModel(workspaceId, modelId))!;
    const changes = await modelSchemaChanges(getDb(), model, null);
    const waiting = changes.find((change) => change.stage === "destructive")!;
    expect(waiting).toMatchObject({ status: "awaiting_confirmation", confirmation: { prompt: expect.stringContaining(apiKey) } });
    expect(waiting.plan.join(" ")).toMatch(/body/i);
    expect(typeof waiting.confirmation!.valuesDeleted).toBe("number");

    // A wrong key changes nothing; the right key lets the worker drop the column.
    await expect(confirmPlanStage(getDb(), { ledgerId: waiting.ledgerId, confirmedBy: adminUserId, typedApiKey: "wrong" })).rejects.toMatchObject({ code: "22023" });
    await confirmPlanStage(getDb(), { ledgerId: waiting.ledgerId, confirmedBy: adminUserId, typedApiKey: apiKey });
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await columns(backend, modelId)).not.toContain("body");
  });

  it("the deletion count reflects the values that would be deleted", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const apiKey = uniqueKey("tile");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Tile", apiKey, fields: [f("title"), f("note")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    await runWorker(modelId);
    for (let i = 0; i < 3; i += 1) {
      const entry = await createEntry({ workspaceId, modelId, data: { title: `T${i}`, note: `N${i}` }, actorAdminUserId: adminUserId });
      if (!entry.ok) throw new Error(entry.error);
    }
    const changed = await applyChange({ model: (await getModel(workspaceId, modelId))!, proposedSchema: { name: "Tile", apiKey, fields: [f("title")] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.applied) throw new Error("change not applied");
    await runWorker(modelId);
    const waiting = (await modelSchemaChanges(getDb(), (await getModel(workspaceId, modelId))!, null)).find((change) => change.stage === "destructive")!;
    expect(waiting.confirmation!.valuesDeleted).toBe(3);
  });

  it("a refused request rolls the write back: no version without its ledger rows, no ledger rows without their version", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    // A model with too many fields for the (lowered) cap: the planner refuses, so nothing is written.
    const before = process.env.POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL;
    process.env.POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL = "1";
    try {
      const apiKey = uniqueKey("wide");
      const refused = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Wide", apiKey, fields: [f("a"), f("b")] } });
      expect(refused).toMatchObject({ ok: false, status: 409 });
      expect(await backend.query("select 1 from content_models where workspace_id = $1 and api_key = $2", [workspaceId, apiKey])).toEqual([]);

      // An existing model: adding a field past the cap leaves the version and the ledger as they were.
      process.env.POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL = "150";
      const narrow = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Narrow", apiKey: uniqueKey("narrow"), fields: [f("a")] } });
      if (!narrow.ok) throw new Error(narrow.error);
      const modelId = narrow.data.model.id;
      const versionsBefore = await backend.query("select id from content_model_versions where content_model_id = $1", [modelId]);
      const ledgerBefore = await ledger(backend, modelId);
      process.env.POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL = "1";
      const model = (await getModel(workspaceId, modelId))!;
      const blocked = await applyChange({ model, proposedSchema: { name: "Narrow", apiKey: model.api_key, fields: [f("a"), f("b")] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
      expect(blocked).toMatchObject({ ok: false, status: 409 });
      expect(await backend.query("select id from content_model_versions where content_model_id = $1", [modelId])).toEqual(versionsBefore);
      expect(await ledger(backend, modelId)).toEqual(ledgerBefore);
      expect((await getModel(workspaceId, modelId))!.current_schema_version).toBe(model.current_schema_version);
    } finally {
      if (before === undefined) delete process.env.POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL;
      else process.env.POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL = before;
    }
    // Every version in this workspace has its ledger rows (and every ledger row its version).
    const orphans = await backend.query(
      `select v.id from content_model_versions v join content_models m on m.id = v.content_model_id
        where m.workspace_id = $1 and not exists (select 1 from schema_migration_ledger l where l.content_model_id = m.id and l.target_version_id = v.id)`, [workspaceId]);
    expect(orphans).toEqual([]);
  });
});
