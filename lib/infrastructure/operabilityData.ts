// PostgreSQL implementation of the operability reads and writes: environment components, System
// Doctor runs, the operability overview and provisioning runs (phase 1, wave 5). Deliberate
// differences from the Supabase path it replaced in phase 1:
// - An environment's component upserts commit together, so a failure never leaves half of its
// capabilities re-evaluated.
// - A doctor run, the environment's health and the audit event commit together; so do a provisioning
// run's completion, the environment's status, the approval marked executed and the audit event.
// - Run, component and environment updates are scoped by workspace_id.
// - Reads have id tie-breaks and bounds; malformed ids find nothing instead of failing on the uuid
// cast; jsonb values are serialized explicitly; database text never reaches the caller.
import { DEFAULT_LIST_LIMIT, getDb, withTransaction, type DbExecutor } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ApprovalQuery = { workspaceId: string; environmentId?: string | null; operation: string; entityId: string; approvalRequestId?: string | null };
export type ComponentInputs = { env: any; connections: any[]; secretProvider: any | null; existing: any[] };
export type DoctorInputs = { env: any | null; connections: any[]; jobs: any[]; sync: any[]; runtime: any | null };
export type OperabilityOverview = { doctorRuns: any[]; provisioningRuns: any[]; components: any[]; backups: any[]; upgrades: any[]; approvals: any[]; websites: any[] };
export type ProvisioningCompletion = {
  workspaceId: string; environmentId: string; runId: string; runPatch: Record<string, unknown>; environmentStatus: string;
  approvalRequestId: string | null; audit: PlatformAuditPayload;
};


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: Array<string | null | undefined>) => values.every((value) => typeof value === "string" && UUID.test(value));
const JSON_COLUMNS = ["metadata_json", "findings_json", "summary_json", "health_json", "safe_input_json", "checks_json", "result_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;
const now = () => new Date().toISOString();

async function markExecuted(executor: DbExecutor, workspaceId: string, requestId: string): Promise<void> {
  if (!ids(requestId)) return;
  await executor.updateTable("infrastructure_approval_requests").set({ status: "executed", executed_at: now(), updated_at: now() })
    .where("workspace_id", "=", workspaceId).where("id", "=", requestId).where("status", "=", "approved").execute();
}

export async function approvedRequests(params: ApprovalQuery): Promise<Array<{ id: string; status: string; expires_at: string | null }>> {
  if ((params.environmentId && !ids(params.environmentId)) || (params.approvalRequestId && !ids(params.approvalRequestId))) return [];
  let query = getDb().selectFrom("infrastructure_approval_requests").select(["id", "status", "expires_at"])
    .where("workspace_id", "=", params.workspaceId).where("operation", "=", params.operation).where("entity_id", "=", params.entityId).where("status", "=", "approved");
  if (params.environmentId) query = query.where("environment_id", "=", params.environmentId);
  if (params.approvalRequestId) query = query.where("id", "=", params.approvalRequestId);
  return query.orderBy("reviewed_at", "desc").orderBy("id").limit(10).execute();
}

export async function markApprovalExecuted(workspaceId: string, requestId: string): Promise<void> {
  await markExecuted(getDb(), workspaceId, requestId);
}

export async function componentInputs(workspaceId: string, environmentId: string): Promise<ComponentInputs | null> {
  if (!ids(environmentId)) return null;
  const db = getDb();
  const env = await db.selectFrom("workspace_environments").select(["id", "database_provider", "storage_provider", "runtime_provider", "secret_provider_id"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst();
  if (!env) return null;
  const [connections, secretProvider, existing] = await Promise.all([
    db.selectFrom("workspace_connections").select(["id", "connector_type", "connector_family", "status", "active", "last_verified_at", "last_success_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    env.secret_provider_id ? db.selectFrom("workspace_secret_providers").select(["id", "provider_kind", "status"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", env.secret_provider_id).executeTakeFirst() : Promise.resolve(undefined),
    db.selectFrom("environment_components").select(["id", "capability_key", "component_key", "provider", "state", "metadata_json", "last_checked_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
  ]);
  return { env, connections, secretProvider: secretProvider ?? null, existing };
}

export async function saveComponents(workspaceId: string, environmentId: string, rows: Array<Record<string, unknown>>): Promise<any[]> {
  if (!ids(environmentId)) return [];
  return withTransaction(async (trx) => {
    for (const row of rows) {
      await trx.insertInto("environment_components").values(json({ ...row, workspace_id: workspaceId, environment_id: environmentId }))
        .onConflict((oc) => oc.columns(["environment_id", "component_key"]).doUpdateSet((eb) => ({
          capability_key: eb.ref("excluded.capability_key"), required: eb.ref("excluded.required"), provider: eb.ref("excluded.provider"), state: eb.ref("excluded.state"),
          metadata_json: eb.ref("excluded.metadata_json"), last_checked_at: eb.ref("excluded.last_checked_at"), updated_at: eb.ref("excluded.updated_at"),
        })).where("environment_components.workspace_id", "=", workspaceId))
        .execute();
    }
    return trx.selectFrom("environment_components").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
      .orderBy("required", "desc").orderBy("component_key").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute();
  });
}

export async function doctorInputs(workspaceId: string, environmentId: string): Promise<DoctorInputs> {
  if (!ids(environmentId)) return { env: null, connections: [], jobs: [], sync: [], runtime: null };
  const db = getDb();
  const [env, connections, jobs, sync, runtime] = await Promise.all([
    db.selectFrom("workspace_environments").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst(),
    db.selectFrom("workspace_connections").select(["id", "name", "connector_type", "status", "last_error_code", "last_error_message", "last_verified_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("delivery_jobs").select(["id", "status", "kind", "updated_at", "last_error_code", "last_error_message"]).where("workspace_id", "=", workspaceId).orderBy("updated_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("analytics_sync_state").select(["status", "fresh_through", "last_success_at", "last_error"]).where("workspace_id", "=", workspaceId).orderBy("connector_id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("cms_runtime_state").select(["schema_migration", "app_version", "worker_version"]).where("singleton", "=", true).executeTakeFirst(),
  ]);
  return { env: env ?? null, connections, jobs, sync, runtime: runtime ?? null };
}

export async function secretProviderKind(workspaceId: string, providerId: string): Promise<{ provider_kind: string; status: string } | null> {
  if (!ids(providerId)) return null;
  return (await getDb().selectFrom("workspace_secret_providers").select(["provider_kind", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", providerId).executeTakeFirst()) ?? null;
}

export async function schemaDeploymentState(workspaceId: string, environmentId: string): Promise<{ deployments: any[]; models: any[] }> {
  if (!ids(environmentId)) return { deployments: [], models: [] };
  const db = getDb();
  // Only the latest deployment per model is used, so it is chosen in SQL instead of reading every row.
  const [deployments, models] = await Promise.all([
    db.selectFrom("environment_schema_deployments").select(["content_model_id", "schema_version", "schema_hash", "status"]).distinctOn("content_model_id")
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("content_model_id").orderBy("deployed_at", "desc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("content_models").select(["id", "api_key", "current_schema_version"]).where("workspace_id", "=", workspaceId).where("status", "=", "active").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
  ]);
  return { deployments, models };
}

export async function recordDoctorRun(row: Record<string, unknown> & { workspace_id: string; environment_id: string }, environmentPatch: (runId: string) => Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const run = await trx.insertInto("system_doctor_runs").values(json(row)).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("workspace_environments").set(json(environmentPatch(run.id))).where("workspace_id", "=", row.workspace_id).where("id", "=", row.environment_id).execute();
      await recordPlatformEvent(trx, audit);
      return run;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not record System Doctor run"));
  }
}

export async function overview(workspaceId: string, environmentId?: string): Promise<OperabilityOverview> {
  if (environmentId && !ids(environmentId)) return { doctorRuns: [], provisioningRuns: [], components: [], backups: [], upgrades: [], approvals: [], websites: [] };
  const db = getDb();
  const inEnv = Boolean(environmentId);
  const env = environmentId ?? "";
  const [doctorRuns, provisioningRuns, components, backups, upgrades, approvals, websites] = await Promise.all([
    db.selectFrom("system_doctor_runs").selectAll().where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("checked_at", "desc").orderBy("id").limit(20).execute(),
    db.selectFrom("environment_provisioning_runs").selectAll().where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("created_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("environment_components").selectAll().where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("component_key").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("workspace_backups").select(["id", "environment_id", "backup_kind", "status", "format_version", "checksum_sha256", "size_bytes", "storage_locator", "created_at", "verified_at", "restored_at"]).where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("created_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("environment_upgrade_runs").selectAll().where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("created_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("infrastructure_approval_requests").selectAll().where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("created_at", "desc").orderBy("id").limit(100).execute(),
    db.selectFrom("website_connection_bindings").selectAll().where("workspace_id", "=", workspaceId).$if(inEnv, (q) => q.where("environment_id", "=", env)).orderBy("created_at", "desc").orderBy("id").limit(50).execute(),
  ]);
  return { doctorRuns, provisioningRuns, components, backups, upgrades, approvals, websites };
}

export async function provisioningRunByKey(workspaceId: string, idempotencyKey: string): Promise<any | null> {
  return (await getDb().selectFrom("environment_provisioning_runs").selectAll().where("workspace_id", "=", workspaceId).where("idempotency_key", "=", idempotencyKey).executeTakeFirst()) ?? null;
}

export async function startProvisioningRun(row: Record<string, unknown>): Promise<any> {
  try {
    return await getDb().insertInto("environment_provisioning_runs").values(json(row)).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not start provisioning run"));
  }
}

export async function markComponentPresent(workspaceId: string, componentId: string): Promise<void> {
  if (!ids(componentId)) return;
  await getDb().updateTable("environment_components").set({ state: "present", last_checked_at: now(), last_error: null, updated_at: now() }).where("workspace_id", "=", workspaceId).where("id", "=", componentId).execute();
}

export async function completeProvisioningRun(input: ProvisioningCompletion): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const done = await trx.updateTable("environment_provisioning_runs").set(json(input.runPatch)).where("workspace_id", "=", input.workspaceId).where("id", "=", input.runId).returningAll().executeTakeFirst();
      await trx.updateTable("workspace_environments").set({ status: input.environmentStatus, updated_at: now() }).where("workspace_id", "=", input.workspaceId).where("id", "=", input.environmentId).execute();
      if (input.approvalRequestId) await markExecuted(trx, input.workspaceId, input.approvalRequestId);
      await recordPlatformEvent(trx, input.audit);
      return done ?? null;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not complete provisioning run"));
  }
}

export async function failProvisioningRun(workspaceId: string, environmentId: string, runId: string, message: string): Promise<void> {
  await withTransaction(async (trx) => {
    await trx.updateTable("environment_provisioning_runs").set({ status: "failed", last_error_code: "PROVISIONING_FAILED", last_error_message: message, completed_at: now(), updated_at: now() }).where("workspace_id", "=", workspaceId).where("id", "=", runId).execute();
    await trx.updateTable("workspace_environments").set({ status: "blocked", updated_at: now() }).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).execute();
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
