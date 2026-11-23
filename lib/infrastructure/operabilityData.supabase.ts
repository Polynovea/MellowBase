// Supabase path of the operability reads and writes: environment components, System Doctor runs,
// the operability overview and provisioning runs (queries moved from operabilityService.ts; deleted
// with the switch at the end of phase 1). Capability inference, the doctor's findings and the
// provisioning checks stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ApprovalQuery = { workspaceId: string; environmentId?: string | null; operation: string; entityId: string; approvalRequestId?: string | null };
export type ComponentInputs = { env: any; connections: any[]; secretProvider: any | null; existing: any[] };
export type DoctorInputs = { env: any | null; connections: any[]; jobs: any[]; sync: any[]; runtime: any | null };
export type OperabilityOverview = { doctorRuns: any[]; provisioningRuns: any[]; components: any[]; backups: any[]; upgrades: any[]; approvals: any[]; websites: any[] };
export type ProvisioningCompletion = {
  workspaceId: string; environmentId: string; runId: string; runPatch: Record<string, unknown>; environmentStatus: string;
  approvalRequestId: string | null; audit: PlatformAuditPayload;
};

/** Approved, unreviewed-for-execution requests for the operation on the entity, latest review first (at most 10). */
export async function approvedRequests(params: ApprovalQuery): Promise<Array<{ id: string; status: string; expires_at: string | null }>> {
  let query = createServiceRoleClient().from("infrastructure_approval_requests").select("id,status,expires_at").eq("workspace_id", params.workspaceId).eq("operation", params.operation).eq("entity_id", params.entityId).eq("status", "approved");
  if (params.environmentId) query = query.eq("environment_id", params.environmentId);
  if (params.approvalRequestId) query = query.eq("id", params.approvalRequestId);
  const { data } = await query.order("reviewed_at", { ascending: false }).limit(10);
  return data ?? [];
}

export async function markApprovalExecuted(workspaceId: string, requestId: string): Promise<void> {
  await createServiceRoleClient().from("infrastructure_approval_requests").update({ status: "executed", executed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", requestId).eq("status", "approved");
}

/** What capability inference reads for an environment, or null when it is not in the workspace. */
export async function componentInputs(workspaceId: string, environmentId: string): Promise<ComponentInputs | null> {
  const db = createServiceRoleClient();
  const { data: env } = await db.from("workspace_environments").select("id,database_provider,storage_provider,runtime_provider,secret_provider_id").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  if (!env) return null;
  const [{ data: connections }, { data: secretProvider }, { data: existing }] = await Promise.all([
    db.from("workspace_connections").select("id,connector_type,connector_family,status,active,last_verified_at,last_success_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    env.secret_provider_id ? db.from("workspace_secret_providers").select("id,provider_kind,status").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", env.secret_provider_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from("environment_components").select("id,capability_key,component_key,provider,state,metadata_json,last_checked_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
  ]);
  return { env, connections: connections ?? [], secretProvider: secretProvider ?? null, existing: existing ?? [] };
}

/** Upserts the environment's component rows, then returns all of them, required first. */
export async function saveComponents(workspaceId: string, environmentId: string, rows: Array<Record<string, unknown>>): Promise<any[]> {
  const db = createServiceRoleClient();
  for (const row of rows) await db.from("environment_components").upsert(row, { onConflict: "environment_id,component_key" });
  const { data } = await db.from("environment_components").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("required", { ascending: false });
  return data ?? [];
}

export async function doctorInputs(workspaceId: string, environmentId: string): Promise<DoctorInputs> {
  const db = createServiceRoleClient();
  const [{ data: env }, { data: connections }, { data: jobs }, { data: sync }, { data: runtime }] = await Promise.all([
    db.from("workspace_environments").select("*").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle(),
    db.from("workspace_connections").select("id,name,connector_type,status,last_error_code,last_error_message,last_verified_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("delivery_jobs").select("id,status,kind,updated_at,last_error_code,last_error_message").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }).limit(50),
    db.from("analytics_sync_state").select("status,fresh_through,last_success_at,last_error").eq("workspace_id", workspaceId),
    db.from("cms_runtime_state").select("schema_migration,app_version,worker_version").eq("singleton", true).maybeSingle(),
  ]);
  return { env: env ?? null, connections: connections ?? [], jobs: jobs ?? [], sync: sync ?? [], runtime: runtime ?? null };
}

export async function secretProviderKind(workspaceId: string, providerId: string): Promise<{ provider_kind: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("workspace_secret_providers").select("provider_kind,status").eq("workspace_id", workspaceId).eq("id", providerId).maybeSingle();
  return data ?? null;
}

/** Schema deployments in the environment (latest first) and the workspace's active models. */
export async function schemaDeploymentState(workspaceId: string, environmentId: string): Promise<{ deployments: any[]; models: any[] }> {
  const db = createServiceRoleClient();
  const schemaRows = await db.from("environment_schema_deployments").select("content_model_id,schema_version,schema_hash,status").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("deployed_at", { ascending: false });
  const models = await db.from("content_models").select("id,api_key,current_schema_version").eq("workspace_id", workspaceId).eq("status", "active");
  return { deployments: schemaRows.data ?? [], models: models.data ?? [] };
}

/** Records a doctor run, the environment's health and the audit event. */
export async function recordDoctorRun(row: Record<string, unknown> & { workspace_id: string; environment_id: string }, environmentPatch: (runId: string) => Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  const db = createServiceRoleClient();
  const { data: run, error } = await db.from("system_doctor_runs").insert(row).select().single();
  if (error || !run) throw new Error(error?.message || "Could not record System Doctor run");
  await db.from("workspace_environments").update(environmentPatch(run.id)).eq("workspace_id", row.workspace_id).eq("id", row.environment_id);
  await logPlatformEvent(audit);
  return run;
}

export async function overview(workspaceId: string, environmentId?: string): Promise<OperabilityOverview> {
  const db = createServiceRoleClient();
  const envFilter = (q: any) => environmentId ? q.eq("environment_id", environmentId) : q;
  const [doctor, provisioning, components, backups, upgrades, approvals, websites] = await Promise.all([
    envFilter(db.from("system_doctor_runs").select("*").eq("workspace_id", workspaceId)).order("checked_at", { ascending: false }).limit(20),
    envFilter(db.from("environment_provisioning_runs").select("*").eq("workspace_id", workspaceId)).order("created_at", { ascending: false }).limit(50),
    envFilter(db.from("environment_components").select("*").eq("workspace_id", workspaceId)).order("component_key"),
    envFilter(db.from("workspace_backups").select("id,environment_id,backup_kind,status,format_version,checksum_sha256,size_bytes,storage_locator,created_at,verified_at,restored_at").eq("workspace_id", workspaceId)).order("created_at", { ascending: false }).limit(50),
    envFilter(db.from("environment_upgrade_runs").select("*").eq("workspace_id", workspaceId)).order("created_at", { ascending: false }).limit(50),
    envFilter(db.from("infrastructure_approval_requests").select("*").eq("workspace_id", workspaceId)).order("created_at", { ascending: false }).limit(100),
    envFilter(db.from("website_connection_bindings").select("*").eq("workspace_id", workspaceId)).order("created_at", { ascending: false }).limit(50),
  ]);
  return { doctorRuns: doctor.data ?? [], provisioningRuns: provisioning.data ?? [], components: components.data ?? [], backups: backups.data ?? [], upgrades: upgrades.data ?? [], approvals: approvals.data ?? [], websites: websites.data ?? [] };
}

export async function provisioningRunByKey(workspaceId: string, idempotencyKey: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("environment_provisioning_runs").select("*").eq("workspace_id", workspaceId).eq("idempotency_key", idempotencyKey).maybeSingle();
  return data ?? null;
}

export async function startProvisioningRun(row: Record<string, unknown>): Promise<any> {
  const { data: run, error } = await createServiceRoleClient().from("environment_provisioning_runs").insert(row).select().single();
  if (error || !run) throw new Error(error?.message || "Could not start provisioning run");
  return run;
}

export async function markComponentPresent(workspaceId: string, componentId: string): Promise<void> {
  void workspaceId; // the component was just read from the workspace's environment
  await createServiceRoleClient().from("environment_components").update({ state: "present", last_checked_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", componentId);
}

/** Completes a provisioning run: the run's result, the environment's status, the approval and the audit event. */
export async function completeProvisioningRun(input: ProvisioningCompletion): Promise<any> {
  const db = createServiceRoleClient();
  const { data: done } = await db.from("environment_provisioning_runs").update(input.runPatch).eq("id", input.runId).select().single();
  await db.from("workspace_environments").update({ status: input.environmentStatus, updated_at: new Date().toISOString() }).eq("workspace_id", input.workspaceId).eq("id", input.environmentId);
  if (input.approvalRequestId) await markApprovalExecuted(input.workspaceId, input.approvalRequestId);
  await logPlatformEvent(input.audit);
  return done;
}

/** Marks a provisioning run failed and its environment blocked. */
export async function failProvisioningRun(workspaceId: string, environmentId: string, runId: string, message: string): Promise<void> {
  const db = createServiceRoleClient();
  await db.from("environment_provisioning_runs").update({ status: "failed", last_error_code: "PROVISIONING_FAILED", last_error_message: message, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", runId);
  await db.from("workspace_environments").update({ status: "blocked", updated_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", environmentId);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
