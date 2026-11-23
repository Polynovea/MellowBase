import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createModel, getVersion } from "@/lib/schema/modelService";
import { deployAssessedCanonicalSchema, getDataAwareChangeAssessment } from "@/lib/intelligence/schemaDeploymentService";
import { discoverPostgresOperationalState } from "@/lib/intelligence/deepDiscoveryService";
import * as discoveryData from "@/lib/intelligence/discoveryData";

const recorder = createRecorder();

async function setup(backend: BackendFixtures, kind = "staging") {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const version = await getVersion(model.data.model.id, model.data.model.current_schema_version);
  if (!version) throw new Error("no schema version");
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, $2, 'Env', $2) returning id", [workspaceId, kind]);
  const assess = async (overrides: Record<string, unknown> = {}) => {
    const row = { status: "passed", deterministic_classification: "safe", target_schema_version: model.data.model.current_schema_version, target_schema_hash: version.schema_hash, provenance_state: "unverified", ...overrides };
    const [assessment] = await backend.query<{ id: string }>(
      `insert into operational_change_assessments (workspace_id, environment_id, content_model_id, current_schema_version, proposed_schema_hash, status, deterministic_classification, target_schema_version, target_schema_hash, provenance_state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [workspaceId, environment.id, model.data.model.id, model.data.model.current_schema_version, version.schema_hash, row.status, row.deterministic_classification, row.target_schema_version, row.target_schema_hash, row.provenance_state],
    );
    return assessment.id;
  };
  return { workspaceId, adminUserId, modelId: model.data.model.id, apiKey: model.data.model.api_key, schemaHash: version.schema_hash, environmentId: environment.id, assess };
}

describeBothBackends(["intelligence", "schema"], "intelligence discovery and canonical schema deployment", (backend) => {
  it("deploys an assessed schema to the workspace's environment and refuses other workspaces and unsafe assessments", async () => {
    const s = await setup(backend);
    const assessmentId = await s.assess();
    expect(await getDataAwareChangeAssessment(s.workspaceId, assessmentId)).toMatchObject({ id: assessmentId, environment_id: s.environmentId });
    const other = await setup(backend, "production");
    await expect(getDataAwareChangeAssessment(other.workspaceId, assessmentId)).rejects.toThrow("Data-aware change assessment not found");
    await expect(getDataAwareChangeAssessment(s.workspaceId, "nope")).rejects.toThrow("Data-aware change assessment not found");
    await expect(deployAssessedCanonicalSchema({ workspaceId: other.workspaceId, environmentId: other.environmentId, modelId: other.modelId, actorId: other.adminUserId, assessmentId })).rejects.toThrow("Data-aware change assessment not found");

    const destructive = await s.assess({ deterministic_classification: "destructive" });
    await expect(deployAssessedCanonicalSchema({ workspaceId: s.workspaceId, environmentId: s.environmentId, modelId: s.modelId, actorId: s.adminUserId, assessmentId: destructive })).rejects.toThrow("Direct canonical deployment is not allowed");
    const lock = await other.assess({ deterministic_classification: "requires_lock" });
    await expect(deployAssessedCanonicalSchema({ workspaceId: other.workspaceId, environmentId: other.environmentId, modelId: other.modelId, actorId: other.adminUserId, assessmentId: lock })).rejects.toThrow("Production schema deployment must be deterministically SAFE");

    const first = await deployAssessedCanonicalSchema({ workspaceId: s.workspaceId, environmentId: s.environmentId, modelId: s.modelId, actorId: s.adminUserId, assessmentId });
    expect(first).toMatchObject({ assessmentId, schemaHash: s.schemaHash, deterministicClassification: "safe", deployment: { workspace_id: s.workspaceId, environment_id: s.environmentId, content_model_id: s.modelId, status: "deployed", deployed_by: s.adminUserId, metadata_json: { assessmentId, migrationStrategy: "direct_metadata_change" } } });
    const again = await deployAssessedCanonicalSchema({ workspaceId: s.workspaceId, environmentId: s.environmentId, modelId: s.modelId, actorId: s.adminUserId, assessmentId });
    expect(again.deployment.id).toBe(first.deployment.id);
    const [environment] = await backend.query<{ deployed_schema_hash: string; deployed_schema_revision: string }>("select deployed_schema_hash, deployed_schema_revision from workspace_environments where id = $1", [s.environmentId]);
    expect(environment).toEqual({ deployed_schema_hash: s.schemaHash, deployed_schema_revision: `${s.apiKey}:v1` });
    const events = await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.schema_change.deployed'", [s.workspaceId]);
    expect(events).toHaveLength(2);
    recorder.record(backend.name, "deployment", { keys: Object.keys(first.deployment).sort(), result: Object.keys(first).sort() });
  });

  it("reads connections, capability rows and overview runs for the workspace's environment only", async () => {
    const s = await setup(backend);
    await backend.query(
      `insert into workspace_connections (workspace_id, environment_id, connector_type, connector_family, name, status, active) values
        ($1, $2, 'database.postgres', 'database', 'Primary', 'configured', true),
        ($1, $2, 'storage.s3', 'storage', 'Bucket', 'active', false)`,
      [s.workspaceId, s.environmentId],
    );
    await backend.query("insert into operational_discovery_runs (workspace_id, environment_id) values ($1, $2)", [s.workspaceId, s.environmentId]);

    const databases = await discoveryData.databaseConnections(s.workspaceId, s.environmentId);
    expect(databases.map((c) => c.connector_type)).toEqual(["database.postgres"]);
    // The only database connection is not active yet, so discovery reports it unsupported without connecting.
    expect(await discoverPostgresOperationalState({ workspaceId: s.workspaceId, environmentId: s.environmentId })).toMatchObject({ supported: false, connectionId: null });

    const capability = await discoveryData.capabilityRows(s.workspaceId, s.environmentId);
    expect(capability.environment).toMatchObject({ id: s.environmentId, kind: "staging" });
    expect(capability.connections.map((c) => c.name).sort()).toEqual(["Bucket", "Primary"]);
    const runs = await discoveryData.overviewRuns(s.workspaceId, s.environmentId);
    expect(runs.discoveryRuns).toHaveLength(1);
    expect(runs.reconciliationRuns).toEqual([]);

    const other = await backend.createWorkspace();
    expect(await discoveryData.databaseConnections(other.workspaceId, s.environmentId)).toEqual([]);
    expect(await discoveryData.capabilityRows(other.workspaceId, s.environmentId)).toEqual({ environment: null, connections: [], components: [], bindings: [] });
    expect((await discoveryData.overviewRuns(other.workspaceId, s.environmentId)).discoveryRuns).toEqual([]);
    expect(await discoveryData.capabilityRows(s.workspaceId, "nope")).toEqual({ environment: null, connections: [], components: [], bindings: [] });
    recorder.record(backend.name, "reads", { connection: Object.keys(capability.connections[0]).sort(), run: Object.keys(runs.discoveryRuns[0]).sort() });
  });
});

describe("intelligence discovery backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
