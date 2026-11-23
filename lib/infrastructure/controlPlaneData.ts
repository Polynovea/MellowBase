// PostgreSQL implementation of the infrastructure control-plane reads and writes (phase 1, wave 5).
// Deliberate differences from the Supabase path it replaced in phase 1:
// - These commit together: a schema deployment, the environment's deployed schema and its approval; a
// backup and its audit event; a website binding and the publication target it creates; a component
// action, the component's state and its approval; an upgrade run's completion and its approval. The
// Supabase path ran each as separate calls, so a failure could leave an approval executed with no
// deployment, or an orphan publication target.
// - Component, binding and upgrade updates are scoped by workspace_id.
// - Messages the approval functions raise for the caller pass through; other database text never does.
// - Reads have id tie-breaks and bounds; malformed ids find nothing instead of failing on the uuid
// cast; jsonb values are serialized explicitly.
import { callFunction, DEFAULT_LIST_LIMIT, getDb, SqlFunctionError, withTransaction, type DbExecutor } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type EnvironmentRow = { id: string; key: string; kind: string; runtime_provider: string | null; database_provider: string | null; storage_provider: string | null };
export type ApprovalRow = { id: string; status: string; operation: string; entity_id: string; expires_at: string | null };
export type SchemaDeployment = { workspaceId: string; environmentId: string; row: Record<string, unknown>; environmentPatch: Record<string, unknown>; approvalRequestId: string | null };
export type WebsiteBinding = { workspaceId: string; environmentId: string; connectionId: string; newTarget: Record<string, unknown> | null; binding: Record<string, unknown> };
export type ComponentRun = { workspaceId: string; componentId: string; run: Record<string, unknown>; componentPatch: Record<string, unknown>; approvalRequestId: string | null };
export type UpgradeCompletion = { workspaceId: string; runId: string; patch: Record<string, unknown>; approvalRequestId: string | null };
export type RequestApprovalArgs = { p_workspace_id: string; p_environment_id: string | null; p_actor_id: string; p_operation: string; p_entity_type: string; p_entity_id: string; p_reason: string; p_request_json: Record<string, unknown> };
export type ReviewApprovalArgs = { p_workspace_id: string; p_actor_id: string; p_request_id: string; p_decision: string; p_note: string | null };


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: Array<string | null | undefined>) => values.every((value) => typeof value === "string" && UUID.test(value));
const JSON_COLUMNS = ["metadata_json", "manifest_json", "payload_json", "compatibility_json", "result_json", "plan_json", "route_mapping_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;
const now = () => new Date().toISOString();
const BACKUP_SUMMARY = ["id", "environment_id", "status", "format_version", "checksum_sha256", "manifest_json", "size_bytes", "created_at", "verified_at"] as const;

async function guarded<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(clientErrorMessage(error, fallback));
  }
}

async function markApprovalExecuted(executor: DbExecutor, workspaceId: string, requestId: string | null): Promise<void> {
  if (!requestId || !ids(requestId)) return;
  await executor.updateTable("infrastructure_approval_requests").set({ status: "executed", executed_at: now(), updated_at: now() })
    .where("workspace_id", "=", workspaceId).where("id", "=", requestId).where("status", "=", "approved").execute();
}

export async function environmentRow(workspaceId: string, environmentId: string): Promise<EnvironmentRow | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("workspace_environments").select(["id", "key", "kind", "runtime_provider", "database_provider", "storage_provider"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst()) ?? null;
}

export async function latestSchemaDeployment(workspaceId: string, environmentId: string, modelId: string): Promise<any | null> {
  if (!ids(environmentId, modelId)) return null;
  return (await getDb().selectFrom("environment_schema_deployments").select(["schema_version", "schema_hash", "status", "deployed_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("content_model_id", "=", modelId).orderBy("deployed_at", "desc").orderBy("id").limit(1).executeTakeFirst()) ?? null;
}

export async function latestApprovedSchemaPromotion(workspaceId: string, environmentId: string, modelId: string): Promise<{ id: string } | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("infrastructure_approval_requests").select("id")
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("operation", "=", "schema_promote").where("entity_id", "=", modelId).where("status", "=", "approved")
    .orderBy("reviewed_at", "desc").orderBy("id").limit(1).executeTakeFirst()) ?? null;
}

export async function approvalById(workspaceId: string, requestId: string): Promise<ApprovalRow | null> {
  if (!ids(requestId)) return null;
  return (await getDb().selectFrom("infrastructure_approval_requests").select(["id", "status", "operation", "entity_id", "expires_at"]).where("workspace_id", "=", workspaceId).where("id", "=", requestId).executeTakeFirst()) ?? null;
}

export async function recordSchemaDeployment(input: SchemaDeployment): Promise<void> {
  await guarded("Could not record schema deployment", () => withTransaction(async (trx) => {
    await trx.insertInto("environment_schema_deployments").values(json(input.row)).execute();
    await trx.updateTable("workspace_environments").set(input.environmentPatch).where("workspace_id", "=", input.workspaceId).where("id", "=", input.environmentId).execute();
    await markApprovalExecuted(trx, input.workspaceId, input.approvalRequestId);
  }));
}

export async function backupSources(workspaceId: string): Promise<{ connections: any[]; environments: any[] }> {
  const db = getDb();
  // A backup manifest must list every connection and environment, so these reads are not capped.
  const [connections, environments] = await Promise.all([
    db.selectFrom("workspace_connections").select(["id", "environment_id", "connector_type", "connector_family", "name", "status", "active", "config_json", "metadata_json", "legacy_resource_type", "legacy_resource_id", "created_at", "updated_at"]).where("workspace_id", "=", workspaceId).orderBy("id").execute(),
    db.selectFrom("workspace_environments").select(["id", "key", "name", "kind", "status", "is_default", "cms_base_url", "public_site_urls", "database_provider", "storage_provider", "runtime_provider", "deployed_schema_hash", "deployed_schema_revision", "config_json", "created_at", "updated_at"]).where("workspace_id", "=", workspaceId).orderBy("id").execute(),
  ]);
  return { connections, environments };
}

export async function insertBackup(row: Record<string, unknown>, audit: (backupId: string) => PlatformAuditPayload): Promise<any> {
  return guarded("Could not create backup", () => withTransaction(async (trx) => {
    const data = await trx.insertInto("workspace_backups").values(json(row)).returning([...BACKUP_SUMMARY]).executeTakeFirstOrThrow();
    await recordPlatformEvent(trx, audit(data.id));
    return data;
  }));
}

export async function backupRow(workspaceId: string, backupId: string): Promise<any | null> {
  if (!ids(backupId)) return null;
  return (await getDb().selectFrom("workspace_backups").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", backupId).executeTakeFirst()) ?? null;
}

export async function insertRestoreRun(row: Record<string, unknown>): Promise<any> {
  return guarded("Could not record restore run", () => getDb().insertInto("workspace_restore_runs").values(json(row)).returningAll().executeTakeFirstOrThrow());
}

export async function portabilityRows(workspaceId: string, environmentId: string): Promise<{ connections: any[]; components: any[]; refs: any[]; assets: any[] }> {
  if (!ids(environmentId)) return { connections: [], components: [], refs: [], assets: [] };
  const db = getDb();
  // Portability must see every asset and secret reference, or a blocker could be missed.
  const [connections, components, refs, assets] = await Promise.all([
    db.selectFrom("workspace_connections").select(["id", "name", "connector_type", "connector_family", "status", "legacy_resource_type"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("environment_components").select(["component_key", "provider", "state", "required"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("component_key").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("workspace_secret_refs").select(["id", "state", "provider_id"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
    db.selectFrom("assets").select(["id", "storage_provider", "storage_key", "archived_at"]).where("workspace_id", "=", workspaceId).orderBy("id").execute(),
  ]);
  return { connections, components, refs, assets };
}

export async function runtimeState(): Promise<any | null> {
  return (await getDb().selectFrom("cms_runtime_state").selectAll().where("singleton", "=", true).executeTakeFirst()) ?? null;
}

export async function insertUpgradeRun(row: Record<string, unknown>): Promise<any> {
  return guarded("Could not create upgrade plan", () => getDb().insertInto("environment_upgrade_runs").values(json(row)).returningAll().executeTakeFirstOrThrow());
}

export async function upgradeRun(workspaceId: string, environmentId: string, runId: string): Promise<any | null> {
  if (!ids(environmentId, runId)) return null;
  return (await getDb().selectFrom("environment_upgrade_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", runId).executeTakeFirst()) ?? null;
}

export async function verifiedBackup(workspaceId: string, backupId: string): Promise<{ id: string; status: string } | null> {
  if (!ids(backupId)) return null;
  return (await getDb().selectFrom("workspace_backups").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", backupId).where("status", "=", "verified").executeTakeFirst()) ?? null;
}

export async function completeUpgrade(input: UpgradeCompletion): Promise<any> {
  return guarded("Could not complete upgrade run", () => withTransaction(async (trx) => {
    const updated = await trx.updateTable("environment_upgrade_runs").set(json(input.patch)).where("workspace_id", "=", input.workspaceId).where("id", "=", input.runId).returningAll().executeTakeFirst();
    await markApprovalExecuted(trx, input.workspaceId, input.approvalRequestId);
    return updated ?? null;
  }));
}

export async function websiteBinding(workspaceId: string, environmentId: string, connectionId: string): Promise<{ id: string; publication_target_id: string | null } | null> {
  if (!ids(environmentId, connectionId)) return null;
  return (await getDb().selectFrom("website_connection_bindings").select(["id", "publication_target_id"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("connection_id", "=", connectionId).executeTakeFirst()) ?? null;
}

export async function bindWebsite(input: WebsiteBinding): Promise<any> {
  return guarded("Could not bind website connection", () => withTransaction(async (trx) => {
    let targetId = (input.binding.publication_target_id as string | null) ?? null;
    if (input.newTarget) targetId = (await trx.insertInto("publication_targets").values(input.newTarget as any).returning("id").executeTakeFirstOrThrow()).id;
    const binding = json({ ...input.binding, publication_target_id: targetId });
    return trx.insertInto("website_connection_bindings").values(binding)
      .onConflict((oc) => oc.columns(["environment_id", "connection_id"]).doUpdateSet({
        publication_target_id: binding.publication_target_id, integration_method: binding.integration_method, model_api_keys: binding.model_api_keys,
        route_mapping_json: binding.route_mapping_json, status: binding.status, updated_at: binding.updated_at,
      }).where("website_connection_bindings.workspace_id", "=", input.workspaceId))
      .returningAll().executeTakeFirstOrThrow();
  }));
}

export async function websiteBindingById(workspaceId: string, bindingId: string): Promise<any | null> {
  if (!ids(bindingId)) return null;
  return (await getDb().selectFrom("website_connection_bindings").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", bindingId).executeTakeFirst()) ?? null;
}

export async function markWebsiteTesting(workspaceId: string, bindingId: string, jobId: string): Promise<void> {
  await getDb().updateTable("website_connection_bindings").set({ status: "testing", last_test_job_id: jobId, last_test_at: now(), updated_at: now() }).where("workspace_id", "=", workspaceId).where("id", "=", bindingId).execute();
}

export async function requestApproval(args: RequestApprovalArgs): Promise<any> {
  if (args.p_environment_id !== null && !ids(args.p_environment_id)) throw new Error("Environment not found");
  let data: unknown;
  try {
    data = await callFunction("cms_request_infrastructure_approval", { ...args, p_request_json: JSON.stringify(args.p_request_json) } as never);
  } catch (error) {
    if (error instanceof SqlFunctionError) throw new Error(error.message);
    throw new Error(clientErrorMessage(error, "Could not request approval"));
  }
  if (!data) throw new Error("Could not request approval");
  return data;
}

export async function reviewApproval(args: ReviewApprovalArgs): Promise<any> {
  if (!ids(args.p_request_id)) throw Object.assign(new Error("Approval request not found"), { status: 400 });
  let data: unknown;
  try {
    data = await callFunction("cms_review_infrastructure_approval", args as never);
  } catch (error) {
    if (error instanceof SqlFunctionError) throw Object.assign(new Error(error.message), { status: error.sqlState === "40300" ? 403 : 400 });
    throw Object.assign(new Error(clientErrorMessage(error, "Could not review approval")), { status: 400 });
  }
  if (!data) throw Object.assign(new Error("Could not review approval"), { status: 400 });
  return data;
}

export async function componentRow(workspaceId: string, environmentId: string, componentId: string): Promise<any | null> {
  if (!ids(environmentId, componentId)) return null;
  return (await getDb().selectFrom("environment_components").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", componentId).executeTakeFirst()) ?? null;
}

export async function recordComponentRun(input: ComponentRun): Promise<any> {
  return guarded("Could not record component action", () => withTransaction(async (trx) => {
    const run = await trx.insertInto("environment_component_runs").values(json(input.run)).returningAll().executeTakeFirstOrThrow();
    await trx.updateTable("environment_components").set(input.componentPatch).where("workspace_id", "=", input.workspaceId).where("id", "=", input.componentId).execute();
    await markApprovalExecuted(trx, input.workspaceId, input.approvalRequestId);
    return run;
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
