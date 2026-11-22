import { describe, expect, it, vi } from "vitest";
import { describeBothBackends } from "@/lib/db/testing/dualBackend";
import { createRecorder, ISO_TIMESTAMP, jsonRequest, LEAKED_DB_ERROR, readJson, routeParams } from "@/lib/db/testing/compare";
import {
  applyChange,
  createModel,
  diffVersions,
  getModel,
  getVersion,
  listModels,
  listVersions,
  rebuildContentFields,
  updateModelMetadata,
  validateChange,
} from "@/lib/schema/modelService";
import { GET as listHandler, POST as createHandler } from "@/app/api/models/route";
import { GET as getHandler, PATCH as patchHandler } from "@/app/api/models/[id]/route";
import { GET as versionsHandler } from "@/app/api/models/[id]/versions/route";
import { GET as diffHandler } from "@/app/api/models/[id]/diff/route";
import { POST as applyHandler } from "@/app/api/models/[id]/apply-change/route";
import { POST as validateHandler } from "@/app/api/models/[id]/validate-change/route";

const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const MODEL_KEYS = ["api_key", "created_at", "created_by", "current_schema_version", "description", "icon", "id", "name", "settings_json", "status", "updated_at", "workspace_id"];
const VERSION_KEYS = ["change_summary", "content_model_id", "created_at", "created_by", "id", "schema_hash", "schema_json", "version_number"];
const recorder = createRecorder();

const schemaV1 = { name: "Blog Post", apiKey: "blog_post", fields: [{ key: "title", label: "Title", type: "text", required: true }] };
const schemaV2 = { ...schemaV1, fields: [...schemaV1.fields, { key: "summary", label: "Summary", type: "text" }] };

describeBothBackends("schema", "schema model service", (backend) => {
  it("creates, lists, versions, diffs and applies changes with identical shapes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createModel({ workspaceId, createdBy: adminUserId, description: "Posts", icon: "pen", proposedSchema: schemaV1 });
    if (!created.ok) throw new Error(created.error);
    const { model, version } = created.data;
    expect(Object.keys(model).sort()).toEqual(MODEL_KEYS);
    expect(Object.keys(version).sort()).toEqual(VERSION_KEYS);
    expect(model).toMatchObject({ name: "Blog Post", api_key: "blog_post", current_schema_version: 1, description: "Posts", icon: "pen" });
    expect(model.created_at).toMatch(ISO_TIMESTAMP);
    expect(version).toMatchObject({ version_number: 1, content_model_id: model.id });

    const listed = await listModels(workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0].current_schema).toMatchObject({ apiKey: "blog_post" });
    expect(await getModel(workspaceId, model.id)).toMatchObject({ id: model.id });
    expect(await getModel(workspaceId, "not-a-uuid")).toBeNull();

    const preview = await validateChange(model, schemaV2);
    expect(preview.ok && preview.data.diff.overallClassification).toBe("SAFE");
    const applied = await applyChange({ model, proposedSchema: schemaV2, changeSummary: "Add summary", acknowledgeUnsafe: false, actorAdminUserId: adminUserId });
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.data).toMatchObject({ applied: true, version: { version_number: 2, change_summary: "Add summary" } });
    expect(Object.keys(applied.data.version!).sort()).toEqual(VERSION_KEYS);

    const current = (await getModel(workspaceId, model.id))!;
    expect(current.current_schema_version).toBe(2);
    expect((await listVersions(model.id)).map((v) => v.version_number)).toEqual([2, 1]);
    expect(await getVersion(model.id, 9)).toBeNull();
    const diff = await diffVersions(model.id, 1, 2);
    expect(diff.ok && diff.data.entries.length).toBeGreaterThan(0);
    expect(await diffVersions(model.id, 1, 9)).toEqual({ ok: false, error: "Version 9 not found", status: 404 });

    const unchanged = await applyChange({ model: current, proposedSchema: schemaV2, acknowledgeUnsafe: false, actorAdminUserId: adminUserId });
    expect(unchanged.ok && unchanged.data).toMatchObject({ applied: false, noChanges: true });
    const destructive = await applyChange({ model: current, proposedSchema: { ...schemaV2, fields: [] }, acknowledgeUnsafe: false, actorAdminUserId: adminUserId });
    expect(destructive.ok && destructive.data.applied).toBe(false);
    expect(await applyChange({ model: current, proposedSchema: { ...schemaV2, apiKey: "renamed" }, acknowledgeUnsafe: true, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 400 });

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'content_model' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["schema.migration.started"]));

    recorder.record(backend.name, "model lifecycle", { model, version, listed, applied: applied.data, diff, versions: await listVersions(model.id) });
  });

  it("refuses a duplicate apiKey with a 409 and a safe message", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schemaV1 });
    const duplicate = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schemaV1 });
    expect(duplicate).toEqual({ ok: false, status: 409, error: 'A content model with apiKey "blog_post" already exists in this workspace' });
    expect(await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Bad", apiKey: "Bad Key!", fields: [] } })).toMatchObject({ ok: false, status: 400 });
  });

  it("updates metadata and rebuilds the content_fields projection", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schemaV2 });
    if (!created.ok) throw new Error(created.error);
    const updated = await updateModelMetadata(workspaceId, created.data.model.id, { description: "New", status: "archived", updated_at: new Date().toISOString() });
    expect(updated).toMatchObject({ description: "New", status: "archived", name: "Blog Post" });

    await rebuildContentFields(created.data.model.id, schemaV2 as never);
    const fields = await backend.query<{ field_key: string; position: number }>("select field_key, position from content_fields where content_model_id = $1 order by position", [created.data.model.id]);
    expect(fields).toEqual([{ field_key: "title", position: 0 }, { field_key: "summary", position: 1 }]);
    await rebuildContentFields(created.data.model.id, { ...schemaV2, fields: [] } as never);
    expect(await backend.query("select 1 from content_fields where content_model_id = $1", [created.data.model.id])).toEqual([]);
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const created = await createModel({ workspaceId: a.workspaceId, createdBy: a.adminUserId, proposedSchema: schemaV1 });
    if (!created.ok) throw new Error(created.error);
    expect(await listModels(b.workspaceId)).toEqual([]);
    expect(await getModel(b.workspaceId, created.data.model.id)).toBeNull();
    await expect(updateModelMetadata(b.workspaceId, created.data.model.id, { description: "Stolen", updated_at: new Date().toISOString() })).rejects.toThrow();
    const foreign = { ...created.data.model, workspace_id: b.workspaceId };
    expect((await applyChange({ model: foreign, proposedSchema: schemaV2, acknowledgeUnsafe: true, actorAdminUserId: b.adminUserId })).ok).toBe(false);
    expect((await getModel(a.workspaceId, created.data.model.id))?.current_schema_version).toBe(1);
  });

  it("serves the model routes end to end without leaking database errors", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    actor.workspaceId = workspaceId;
    actor.adminUserId = adminUserId;
    const created = await readJson(await createHandler(jsonRequest({ schema: schemaV1 })));
    expect(created.status).toBeLessThan(300);
    const id = created.body.data.model.id as string;
    expect((await readJson(await listHandler(jsonRequest(undefined, "http://cms.test/api/models")))).body.data).toHaveLength(1);
    expect(await readJson(await getHandler(jsonRequest(), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { id } } });
    expect(await readJson(await getHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })))).toMatchObject({ status: 404 });
    expect(await readJson(await patchHandler(jsonRequest({ description: "Hi" }, "http://cms.test/api/models/x", "PATCH"), routeParams({ id })))).toMatchObject({ status: 200, body: { data: { description: "Hi" } } });
    expect(await readJson(await validateHandler(jsonRequest({ schema: schemaV2 }), routeParams({ id })))).toMatchObject({ status: 200 });
    expect(await readJson(await applyHandler(jsonRequest({ schema: schemaV2 }), routeParams({ id })))).toMatchObject({ status: 201, body: { data: { applied: true } } });
    expect((await readJson(await versionsHandler(jsonRequest(), routeParams({ id })))).body.data).toHaveLength(2);
    expect(await readJson(await diffHandler(jsonRequest(undefined, "http://cms.test/api/models/x/diff?from=1&to=2"), routeParams({ id })))).toMatchObject({ status: 200 });

    const duplicate = await readJson(await createHandler(jsonRequest({ schema: schemaV1 })));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).not.toMatch(LEAKED_DB_ERROR);
    const badStatus = await readJson(await patchHandler(jsonRequest({ status: "archived", icon: "x".repeat(10) }, "http://cms.test/api/models/x", "PATCH"), routeParams({ id })));
    expect(badStatus.status).toBe(200);
  });
});

describe("schema backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
