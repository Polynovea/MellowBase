import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { createEntry } from "@/lib/content/entryService";
import { createModel, getVersion } from "@/lib/schema/modelService";
import { executeAssessedMigrationStrategy, listMigrationRuns } from "@/lib/intelligence/migrationStrategyService";
import * as migrationRunData from "@/lib/intelligence/migrationRunData";

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const modelId = model.data.model.id;
  const version = await getVersion(modelId, 1);
  if (!version) throw new Error("no schema version");
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, 'staging', 'Staging', 'staging') returning id", [workspaceId]);
  const assess = async (classification: string, blockers: unknown[]) => {
    const [row] = await backend.query<{ id: string }>(
      `insert into operational_change_assessments (workspace_id, environment_id, content_model_id, current_schema_version, proposed_schema_hash, status, deterministic_classification, target_schema_version, target_schema_hash, provenance_state, hard_blockers_json, data_profile_json)
       values ($1, $2, $3, 1, $4, $5, $6, 1, $4, 'proven', $7::jsonb, '{"entryCount": 3}'::jsonb) returning id`,
      [workspaceId, environment.id, modelId, version.schema_hash, blockers.length ? "blocked" : "passed", classification, JSON.stringify(blockers)],
    );
    return row.id;
  };
  const entries: string[] = [];
  for (const title of [" Alpha ", "Beta", " Gamma"]) {
    const entry = await createEntry({ workspaceId, modelId, data: { title }, actorAdminUserId: adminUserId });
    if (!entry.ok) throw new Error(entry.error);
    entries.push(entry.data.entry.id);
  }
  return { workspaceId, adminUserId, modelId, environmentId: environment.id, assess, entries: entries.sort() };
}

describeWithDatabase("migration strategy runs", (backend) => {
  it("runs a direct metadata change once, then reports it as already done", async () => {
    const s = await setup(backend);
    const assessmentId = await s.assess("safe", []);
    const params = { workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId, assessmentId, strategyKey: "direct_metadata_change" as const };
    const first = await executeAssessedMigrationStrategy(params);
    expect(first.run).toMatchObject({ workspace_id: s.workspaceId, status: "succeeded", strategy_key: "direct_metadata_change", postcondition_json: { deployed: true, schemaVersion: 1 } });
    const again = await executeAssessedMigrationStrategy(params);
    expect(again).toMatchObject({ resumed: true, alreadySucceeded: true, run: { id: first.run.id } });
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.migration.succeeded'", [s.workspaceId])).toHaveLength(1);

    const other = await setup(backend);
    await expect(executeAssessedMigrationStrategy({ ...params, workspaceId: other.workspaceId, environmentId: other.environmentId, actorId: other.adminUserId })).rejects.toThrow("Data-aware change assessment not found");
    expect((await listMigrationRuns(s.workspaceId, s.environmentId)).map((r) => r.id)).toEqual([first.run.id]);
    expect(await listMigrationRuns(other.workspaceId, s.environmentId)).toEqual([]);
    expect(await listMigrationRuns(s.workspaceId, "nope")).toEqual([]);
  });

  it("transforms entries in batches, records each batch and stops at verification without a database connection", async () => {
    const s = await setup(backend);
    const assessmentId = await s.assess("requires_data_migration", [{ code: "INCOMPATIBLE_TYPE_VALUES", fieldKey: "title" }]);
    await expect(executeAssessedMigrationStrategy({
      workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId, assessmentId, strategyKey: "copy_transform_verify",
      input: { batchSize: 2, transforms: [{ fieldKey: "title", operator: "trim_string" }] },
    })).rejects.toThrow("No active PostgreSQL/Supabase database connection");

    const [run] = await listMigrationRuns(s.workspaceId, s.environmentId);
    expect(run).toMatchObject({ status: "running", progress_json: { batches: 2, processed: 3, succeeded: 3, failed: 0 }, cursor_json: { lastEntryId: s.entries[2], endReached: true } });
    const batches = await backend.query<{ batch_number: number; status: string; processed_count: number; cursor_after_json: unknown }>("select batch_number, status, processed_count, cursor_after_json from operational_migration_batches where migration_run_id = $1 order by batch_number", [run.id]);
    expect(batches).toEqual([
      { batch_number: 1, status: "succeeded", processed_count: 2, cursor_after_json: { lastEntryId: s.entries[1], endReached: false } },
      { batch_number: 2, status: "succeeded", processed_count: 1, cursor_after_json: { lastEntryId: s.entries[2], endReached: true } },
    ]);
    const titles = await backend.query<{ title: string }>("select v.data_jsonb->>'title' as title from content_entries e join content_entry_versions v on v.id = e.current_draft_version_id where e.workspace_id = $1 order by 1", [s.workspaceId]);
    expect(titles.map((t) => t.title)).toEqual(["Alpha", "Beta", "Gamma"]);

    const other = await setup(backend);
    expect(await migrationRunData.entryBatch(other.workspaceId, s.modelId, null, 10)).toEqual([]);
    expect((await migrationRunData.entryBatch(s.workspaceId, s.modelId, s.entries[0], 10)).map((row) => row.entry.id)).toEqual(s.entries.slice(1));
  });
});
