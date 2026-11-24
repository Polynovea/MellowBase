// Phase 4: saving a model in the CMS queues its schema change in the same transaction, and the
// schema worker applies it (Phase 3 built the runner; nothing called it outside content:move).
import { afterAll, expect, it, vi } from "vitest";
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
  // Each runWorker starts a worker process (with the loader); a test may start two or three.
  vi.setConfig({ testTimeout: 120_000 });
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
    // The version's expand row (no steps: it records the version on the table) ran; the deletion waits.
    const rows = await ledger(backend, modelId);
    expect(rows.slice(-2)).toEqual([{ stage: "destructive", status: "awaiting_confirmation" }, { stage: "expand", status: "succeeded" }]);
    expect(await columns(backend, modelId)).toEqual(expect.arrayContaining(["title", "body"]));

    // The model response's view: the deletion in plain words, with the values it would delete.
    const model = (await getModel(workspaceId, modelId))!;
    const changes = await modelSchemaChanges(getDb(), model, null, { countValues: true });
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
    const waiting = (await modelSchemaChanges(getDb(), (await getModel(workspaceId, modelId))!, null, { countValues: true })).find((change) => change.stage === "destructive")!;
    expect(waiting.confirmation!.valuesDeleted).toBe(3);
  }, 120_000);

  it("a deletion whose count fails is still shown, without a count, and the other changes are not hidden", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const apiKey = uniqueKey("slab");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Slab", apiKey, fields: [f("title"), f("note")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    await runWorker(modelId);
    const changed = await applyChange({ model: (await getModel(workspaceId, modelId))!, proposedSchema: { name: "Slab", apiKey, fields: [f("title")] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.applied) throw new Error("change not applied");
    await runWorker(modelId);
    const [{ table_name: table }] = await backend.query<{ table_name: string }>("select table_name from content_model_tables where content_model_id = $1", [modelId]);
    // Behind the engine's back, the column is not where the recorded shape says: counting it fails (42703).
    await backend.query(`alter table content.${table} rename column note to note_away`);
    try {
      const changes = await modelSchemaChanges(getDb(), (await getModel(workspaceId, modelId))!, null, { countValues: true });
      const waiting = changes.find((change) => change.stage === "destructive")!;
      expect(waiting).toMatchObject({ status: "awaiting_confirmation", confirmation: { prompt: expect.stringContaining(apiKey), valuesDeleted: null } });
      expect(waiting.plan.join(" ")).toMatch(/note/i);
      // A caller who may not confirm gets no count either way (nothing is counted for them).
      const forReaders = await modelSchemaChanges(getDb(), (await getModel(workspaceId, modelId))!, null, { countValues: false });
      expect(forReaders.find((change) => change.stage === "destructive")!.confirmation!.valuesDeleted).toBeNull();
    } finally {
      await backend.query(`alter table content.${table} rename column note_away to note`);
    }
  });

  it("adding back a field waiting to be deleted restores it with its values and rules; the deletion is superseded", async () => {
    const { workspaceId, adminUserId } = await workspace(backend);
    const apiKey = uniqueKey("memo");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Memo", apiKey, fields: [f("title"), f("secret")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    for (let i = 0; i < 2; i += 1) {
      const entry = await createEntry({ workspaceId, modelId, data: { title: `T${i}`, secret: `S${i}` }, actorAdminUserId: adminUserId });
      if (!entry.ok) throw new Error(entry.error);
    }
    const [role] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name, description, is_system) values ($1, 'memo_reader', 'Memo reader', 'test', false) returning id", [workspaceId]);
    await backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id, can_read, can_write) values ($1, $2, 'secret', $3, false, false)", [workspaceId, modelId, role.id]);
    const save = async (fields: FieldDefinition[]) => {
      const changed = await applyChange({ model: (await getModel(workspaceId, modelId))!, proposedSchema: { name: "Memo", apiKey, fields }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
      if (!changed.ok || !changed.data.applied) throw new Error(`change not applied: ${changed.ok ? changed.data.blockedReason : changed.error}`);
      return changed.data;
    };
    const removed = await save([f("title")]);
    await runWorker(modelId);
    expect((await ledger(backend, modelId)).slice(-2)).toEqual([{ stage: "destructive", status: "awaiting_confirmation" }, { stage: "expand", status: "succeeded" }]);

    const restored = await save([f("title"), f("secret")]);
    expect(restored.schemaChange?.restored).toEqual([{ field: "secret", values: 2 }]);
    expect(await backend.query("select status from schema_migration_ledger where id = $1", [removed.schemaChange!.destructiveLedgerId])).toEqual([{ status: "superseded" }]);
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await columns(backend, modelId)).toEqual(expect.arrayContaining(["title", "secret"]));
    const [table] = await backend.query<{ table_name: string; applied_version_id: string }>("select table_name, applied_version_id from content_model_tables where content_model_id = $1", [modelId]);
    expect(table.applied_version_id).toBe(restored.version!.id);
    expect((await backend.query<{ secret: string }>(`select secret from content.${table.table_name} where _variant = 'draft' order by secret`)).map((row) => row.secret)).toEqual(["S0", "S1"]);
    // Its permission rule came back with it.
    expect(await backend.query("select can_read from content_field_permissions where content_model_id = $1 and field_key = 'secret'", [modelId])).toEqual([{ can_read: false }]);
    // Nothing is waiting any more.
    expect((await modelSchemaChanges(getDb(), (await getModel(workspaceId, modelId))!, null, { countValues: true })).filter((change) => change.status === "awaiting_confirmation")).toEqual([]);
  });

  it("a save that changes no column keeps the model on its table (the worker records the new version)", async () => {
    // Before, such a save queued nothing: the table stayed on the old version and reads fell back to the
    // snapshots for good.
    const { workspaceId, adminUserId } = await workspace(backend);
    const apiKey = uniqueKey("page");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey, fields: [f("title")] } });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id;
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await tableSource(workspaceId, modelId)).not.toBeNull();
    // A validation change is a new version but changes no column.
    const changed = await applyChange({ model: (await getModel(workspaceId, modelId))!, proposedSchema: { name: "Page", apiKey, fields: [f("title", "text", { validation: { maxLength: 50 } })] }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId });
    if (!changed.ok || !changed.data.applied) throw new Error(`change not applied: ${changed.ok ? changed.data.blockedReason : changed.error}`);
    expect(changed.data.schemaChange).toMatchObject({ expandLedgerId: expect.any(String), destructiveLedgerId: null });
    expect(await runWorker(modelId)).toEqual(["succeeded"]);
    expect(await tableSource(workspaceId, modelId)).not.toBeNull();
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
