import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";

const ops = await import("@/lib/infrastructure/operabilityService");
const { createEnvironment } = await import("@/lib/infrastructure/environmentService");
const { createConnection } = await import("@/lib/infrastructure/connectionService");
const { createModel } = await import("@/lib/schema/modelService");
const schemaV1 = { name: "Note", apiKey: "note", fields: [{ key: "title", label: "Title", type: "text", required: true }] };

async function rejection(promise: Promise<unknown>): Promise<{ message: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return { message: (error as Error).message, status: (error as { status?: number }).status };
  }
  throw new Error("expected a rejection");
}

async function setup(backend: BackendFixtures, kind: "development" | "production" = "development") {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const { environment } = await createEnvironment({ workspaceId, actorId: adminUserId, key: kind === "production" ? "prod" : "dev", name: kind, kind, runtimeProvider: "vercel", secretProviderKind: "environment" });
  return { workspaceId, actorId: adminUserId, environmentId: environment.id as string };
}

async function secondAdmin(backend: BackendFixtures) {
  const suffix = randomUUID().slice(0, 8);
  const [admin] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $2) returning id", [`reviewer-${suffix}`, `reviewer-${suffix}@example.test`]);
  return admin.id;
}

describeWithDatabase("infrastructure control plane", (backend) => {
  it("deploys a schema to an environment and records the deployment", async () => {
    const s = await setup(backend);
    const created = await createModel({ workspaceId: s.workspaceId, createdBy: s.actorId, proposedSchema: schemaV1 });
    if (!created.ok) throw new Error(created.error);
    const modelId = created.data.model.id as string;
    const proposed = { ...schemaV1, fields: [...schemaV1.fields, { key: "body", label: "Body", type: "text" }] };
    const plan = await ops.planEnvironmentSchema({ ...s, modelId, proposedSchema: proposed });
    expect(plan).toMatchObject({ model: { id: modelId, apiKey: "note", currentVersion: 1 }, classification: "SAFE", requiresApproval: false, currentDeployment: null });
    const applied = await ops.applyEnvironmentSchema({ ...s, modelId, proposedSchema: proposed, acknowledgeUnsafe: false });
    expect(applied).toMatchObject({ environmentId: s.environmentId, schemaVersion: 2, classification: "SAFE" });
    expect((await ops.planEnvironmentSchema({ ...s, modelId, proposedSchema: proposed })).currentDeployment).toMatchObject({ schema_version: 2, status: "deployed" });
    const [env] = await backend.query<{ deployed_schema_revision: string }>("select deployed_schema_revision from workspace_environments where id = $1", [s.environmentId]);
    expect(env.deployed_schema_revision).toBe("note:v2");

    const other = await backend.createWorkspace();
    expect(await rejection(ops.applyEnvironmentSchema({ workspaceId: other.workspaceId, actorId: other.adminUserId, environmentId: s.environmentId, modelId, proposedSchema: proposed, acknowledgeUnsafe: false }))).toEqual({ message: "Model not found", status: 404 });
  });

  it("creates backups, plans restores and upgrades, and checks portability inside the workspace", async () => {
    const s = await setup(backend);
    const backup = await ops.createWorkspaceBackup(s);
    expect(backup).toMatchObject({ environment_id: s.environmentId, status: "verified", format_version: 1, manifest_json: { format: "polynovea-cms-backup", environments: [{ id: s.environmentId }] } });
    expect(Object.keys(backup)).not.toContain("payload_json");
    expect(backup.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'infrastructure.backup.created'", [s.workspaceId])).toHaveLength(1);

    const dry = await ops.restoreBackup({ ...s, backupId: backup.id, dryRun: true });
    expect(dry).toMatchObject({ mode: "dry_run", status: "planned", compatibility_json: { checksumMatches: true, canRestore: true } });
    expect(await rejection(ops.restoreBackup({ ...s, backupId: backup.id, dryRun: false }))).toEqual({ message: "Restore-over-existing requires an approved infrastructure request", status: 409 });

    const portability = await ops.portabilityCheck(s.workspaceId, s.environmentId);
    expect(portability).toMatchObject({ portable: true, summary: { blockers: 0, connections: 0, assets: 0 } });

    const plan = await ops.planUpgrade({ ...s, targetMigration: "9999" });
    expect(plan).toMatchObject({ status: "planned", risk: "review", target_migration: "9999", plan_json: { backupRequired: true } });
    expect(await rejection(ops.executeUpgrade({ ...s, upgradeRunId: plan.id }))).toEqual({ message: "This upgrade requires a verified backup", status: 409 });

    const other = await setup(backend);
    const foreignBackup = await ops.createWorkspaceBackup(other);
    expect(await rejection(ops.executeUpgrade({ ...s, upgradeRunId: plan.id, backupId: foreignBackup.id }))).toEqual({ message: "Verified backup not found", status: 409 });
    expect(await rejection(ops.executeUpgrade({ ...s, upgradeRunId: plan.id, backupId: backup.id }))).toEqual({ message: "Upgrade requires an approved infrastructure request", status: 409 });
    const safe = await ops.planUpgrade({ ...s, targetMigration: (await backend.query<{ schema_migration: string }>("select schema_migration from cms_runtime_state where singleton"))[0].schema_migration, targetAppVersion: "0.0.0-test" });
    expect(await ops.executeUpgrade({ ...s, upgradeRunId: safe.id, backupId: backup.id })).toMatchObject({ id: safe.id, status: "blocked", backup_id: backup.id, result_json: { executed: false } });

    expect(await rejection(ops.restoreBackup({ ...s, backupId: foreignBackup.id, dryRun: true }))).toEqual({ message: "Backup not found", status: 404 });
    expect(await rejection(ops.createWorkspaceBackup({ ...s, environmentId: other.environmentId }))).toEqual({ message: "Environment not found", status: 404 });
    expect(await rejection(ops.planUpgrade({ ...s, environmentId: other.environmentId }))).toEqual({ message: "Environment not found", status: 404 });
    expect(await rejection(ops.executeUpgrade({ ...other, upgradeRunId: plan.id }))).toEqual({ message: "Upgrade plan not found", status: 404 });
    expect(await ops.portabilityCheck(s.workspaceId, "nope")).toMatchObject({ portable: true, summary: { connections: 0 } });
  });

  it("requests and reviews approvals, runs component actions and binds website connections", async () => {
    const s = await setup(backend, "production");
    const components = await ops.ensureEnvironmentComponents(s.workspaceId, s.environmentId);
    const worker = components.find((c) => c.component_key === "delivery-worker")!;
    const checked = await ops.runComponentAction({ ...s, componentId: worker.id, operation: "check" });
    expect(checked).toMatchObject({ component_id: worker.id, operation: "check", status: "succeeded", result_json: { state: "present" } });
    expect(await rejection(ops.runComponentAction({ ...s, componentId: worker.id, operation: "deploy" }))).toEqual({ message: "Production component changes require approval.", status: 409 });

    const request = await ops.requestInfrastructureApproval({ ...s, operation: "component_deploy", entityType: "environment_component", entityId: worker.id, reason: "Deploy worker" });
    expect(request).toMatchObject({ workspace_id: s.workspaceId, status: "pending", operation: "component_deploy" });
    expect(await rejection(ops.reviewInfrastructureApproval({ workspaceId: s.workspaceId, actorId: s.actorId, requestId: request.id, decision: "approved" }))).toEqual({ message: "Requester cannot approve their own high-risk operation", status: 403 });
    const reviewer = await secondAdmin(backend);
    expect(await ops.reviewInfrastructureApproval({ workspaceId: s.workspaceId, actorId: reviewer, requestId: request.id, decision: "approved" })).toMatchObject({ status: "approved", reviewed_by: reviewer });
    const deployed = await ops.runComponentAction({ ...s, componentId: worker.id, operation: "deploy" });
    expect(deployed).toMatchObject({ status: "unsupported" });
    expect(await rejection(ops.requestInfrastructureApproval({ ...s, operation: "launch", entityType: "x", entityId: "y", reason: "z" }))).toEqual({ message: "Unsupported approval operation", status: undefined });

    const connection = await createConnection({ workspaceId: s.workspaceId, actorId: s.actorId, environmentId: s.environmentId, connectorType: "website.rest", name: "Site", config: { baseUrl: "https://93.184.215.14" } });
    expect(await rejection(ops.bindWebsiteConnection({ ...s, connectionId: connection.connection.id, integrationMethod: "polynovea_rest" }))).toEqual({ message: "Verify the connection before binding it for publishing", status: 409 });
    await backend.query("update workspace_connections set status = 'active' where id = $1", [connection.connection.id]);
    const bound = await ops.bindWebsiteConnection({ ...s, connectionId: connection.connection.id, integrationMethod: "polynovea_rest", modelApiKeys: ["note", "note"] });
    expect(bound).toMatchObject({ connection_id: connection.connection.id, status: "active", model_api_keys: ["note"], credentialSource: "connection" });
    const rebound = await ops.bindWebsiteConnection({ ...s, connectionId: connection.connection.id, integrationMethod: "polynovea_rest", modelApiKeys: [] });
    expect(rebound).toMatchObject({ id: bound.id, publication_target_id: bound.publication_target_id, model_api_keys: [] });
    expect(await backend.query("select 1 from publication_targets where workspace_id = $1", [s.workspaceId])).toHaveLength(1);
    const job = await ops.queueWebsiteTest({ workspaceId: s.workspaceId, actorId: s.actorId, bindingId: bound.id });
    const [binding] = await backend.query<{ status: string; last_test_job_id: string }>("select status, last_test_job_id from website_connection_bindings where id = $1", [bound.id]);
    expect(binding).toEqual({ status: "testing", last_test_job_id: job.id });

    const other = await backend.createWorkspace();
    const foreign = { workspaceId: other.workspaceId, actorId: other.adminUserId };
    expect(await rejection(ops.runComponentAction({ ...foreign, environmentId: s.environmentId, componentId: worker.id, operation: "check" }))).toEqual({ message: "Environment component not found", status: 404 });
    expect(await rejection(ops.queueWebsiteTest({ ...foreign, bindingId: bound.id }))).toEqual({ message: "Website binding not found", status: 404 });
    expect(await rejection(ops.reviewInfrastructureApproval({ ...foreign, requestId: request.id, decision: "approved" }))).toMatchObject({ message: "Approval request not found" });
    expect(await rejection(ops.bindWebsiteConnection({ ...foreign, environmentId: s.environmentId, connectionId: connection.connection.id, integrationMethod: "polynovea_rest" }))).toEqual({ message: "Website connection not found in environment", status: 404 });
  });
});
