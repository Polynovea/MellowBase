import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { createModel, getVersion } from "@/lib/schema/modelService";
import { assessDataAwareSchemaChange, listDataAwareChangeAssessments } from "@/lib/intelligence/migrationIntelligenceService";
import * as migrationIntelData from "@/lib/intelligence/migrationIntelData";
const schema = { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] };

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: schema });
  if (!model.ok) throw new Error(model.error);
  const version = await getVersion(model.data.model.id, 1);
  if (!version) throw new Error("no schema version");
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, 'staging', 'Staging', 'staging') returning id", [workspaceId]);
  return { workspaceId, adminUserId, modelId: model.data.model.id, versionId: version.id, schemaHash: version.schema_hash, environmentId: environment.id };
}

describeWithDatabase("data-aware change assessments", (backend) => {
  it("reads assessment sources and lists assessments inside the workspace", async () => {
    const s = await setup(backend);
    expect(await migrationIntelData.assessmentSources(s.workspaceId, s.environmentId, s.modelId, s.schemaHash)).toEqual({ targetVersion: { id: s.versionId, version_number: 1, schema_hash: s.schemaHash, schema_json: expect.objectContaining({ apiKey: "page" }) }, sourceDeployment: null });
    await backend.query(
      "insert into environment_schema_deployments (workspace_id, environment_id, content_model_id, schema_version, schema_hash, status, deployed_at) values ($1, $2, $3, 1, $4, 'deployed', now() - interval '1 day'), ($1, $2, $3, 2, 'newer', 'drifted', now())",
      [s.workspaceId, s.environmentId, s.modelId, s.schemaHash],
    );
    const sources = await migrationIntelData.assessmentSources(s.workspaceId, s.environmentId, s.modelId, s.schemaHash);
    expect(sources.sourceDeployment).toMatchObject({ schema_version: 2, schema_hash: "newer", status: "drifted" });

    const other = await setup(backend);
    expect(await migrationIntelData.assessmentSources(other.workspaceId, s.environmentId, s.modelId, s.schemaHash)).toEqual({ targetVersion: null, sourceDeployment: null });

    // No database connection for the environment: the assessment stops before profiling anything.
    await expect(assessDataAwareSchemaChange({ workspaceId: s.workspaceId, environmentId: s.environmentId, modelId: s.modelId, actorId: s.adminUserId, proposedSchema: schema })).rejects.toThrow("No active PostgreSQL/Supabase database connection");
    await expect(assessDataAwareSchemaChange({ workspaceId: other.workspaceId, environmentId: other.environmentId, modelId: s.modelId, actorId: other.adminUserId, proposedSchema: schema })).rejects.toThrow("Model not found");

    const persisted = await migrationIntelData.recordAssessment({
      workspace_id: s.workspaceId, environment_id: s.environmentId, content_model_id: s.modelId, current_schema_version: 1, target_schema_version: 1, target_schema_hash: s.schemaHash,
      proposed_schema_hash: s.schemaHash, status: "passed", deterministic_classification: "safe", provenance_state: "proven", provenance_json: { checks: ["hash"] },
      schema_diff_json: { fields: [] }, data_profile_json: { entryCount: 0 }, hard_blockers_json: [], warnings_json: [{ code: "W" }], alternatives_json: [], estimate_json: { lockRisk: "low" }, created_by: s.adminUserId,
    }, {
      workspace_id: s.workspaceId, environment_id: s.environmentId, event_type: "schema_change.assessment", source_type: "operational_change_assessment",
      features_json: { blockerCount: 0 }, outcome_json: { status: "passed" }, privacy_class: "operational_minimized", eligible_for_local_learning: true, eligible_for_cross_install_learning: false,
    }, (recorded) => ({ workspaceId: s.workspaceId, actorAdminUserId: s.adminUserId, action: "operational.schema_change.assessed", entityType: "content_model", entityId: s.modelId, metadata: { assessmentId: recorded.id } }));
    expect(persisted).toMatchObject({ workspace_id: s.workspaceId, status: "passed", provenance_json: { checks: ["hash"] }, hard_blockers_json: [], warnings_json: [{ code: "W" }] });
    const [event] = await backend.query<{ source_id: string; features_json: unknown }>("select source_id, features_json from operational_events where workspace_id = $1 and event_type = 'schema_change.assessment'", [s.workspaceId]);
    expect(event).toEqual({ source_id: persisted.id, features_json: { blockerCount: 0 } });
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.schema_change.assessed'", [s.workspaceId])).toHaveLength(1);

    expect((await listDataAwareChangeAssessments(s.workspaceId, s.environmentId)).map((a) => a.id)).toEqual([persisted.id]);
    expect((await listDataAwareChangeAssessments(s.workspaceId, s.environmentId, s.modelId)).map((a) => a.id)).toEqual([persisted.id]);
    expect(await listDataAwareChangeAssessments(s.workspaceId, s.environmentId, other.modelId)).toEqual([]);
    expect(await listDataAwareChangeAssessments(other.workspaceId, s.environmentId)).toEqual([]);
    expect(await listDataAwareChangeAssessments(s.workspaceId, "nope")).toEqual([]);
  });
});
