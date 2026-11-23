// Supabase path of the infrastructure control-plane reads and writes: schema deployments, backups and
// restores, portability, upgrades, website bindings, approval requests and component actions
// (queries moved from operabilityService.ts; deleted with the switch at the end of phase 1). The
// approval gates, backup checksums, provider adapters and instructions stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type EnvironmentRow = { id: string; key: string; kind: string; runtime_provider: string | null; database_provider: string | null; storage_provider: string | null };
export type ApprovalRow = { id: string; status: string; operation: string; entity_id: string; expires_at: string | null };
export type SchemaDeployment = { workspaceId: string; environmentId: string; row: Record<string, unknown>; environmentPatch: Record<string, unknown>; approvalRequestId: string | null };
export type WebsiteBinding = { workspaceId: string; environmentId: string; connectionId: string; newTarget: Record<string, unknown> | null; binding: Record<string, unknown> };
export type ComponentRun = { workspaceId: string; componentId: string; run: Record<string, unknown>; componentPatch: Record<string, unknown>; approvalRequestId: string | null };
export type UpgradeCompletion = { workspaceId: string; runId: string; patch: Record<string, unknown>; approvalRequestId: string | null };
export type RequestApprovalArgs = { p_workspace_id: string; p_environment_id: string | null; p_actor_id: string; p_operation: string; p_entity_type: string; p_entity_id: string; p_reason: string; p_request_json: Record<string, unknown> };
export type ReviewApprovalArgs = { p_workspace_id: string; p_actor_id: string; p_request_id: string; p_decision: string; p_note: string | null };

const BACKUP_SUMMARY = "id,environment_id,status,format_version,checksum_sha256,manifest_json,size_bytes,created_at,verified_at";

async function markApprovalExecuted(workspaceId: string, requestId: string | null): Promise<void> {
  if (!requestId) return;
  await createServiceRoleClient().from("infrastructure_approval_requests").update({ status: "executed", executed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", requestId).eq("status", "approved");
}

export async function environmentRow(workspaceId: string, environmentId: string): Promise<EnvironmentRow | null> {
  const { data } = await createServiceRoleClient().from("workspace_environments").select("id,key,kind,runtime_provider,database_provider,storage_provider").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  return data ?? null;
}

export async function latestSchemaDeployment(workspaceId: string, environmentId: string, modelId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("environment_schema_deployments").select("schema_version,schema_hash,status,deployed_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("content_model_id", modelId).order("deployed_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

export async function latestApprovedSchemaPromotion(workspaceId: string, environmentId: string, modelId: string): Promise<{ id: string } | null> {
  const { data } = await createServiceRoleClient().from("infrastructure_approval_requests").select("id").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("operation", "schema_promote").eq("entity_id", modelId).eq("status", "approved").order("reviewed_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

export async function approvalById(workspaceId: string, requestId: string): Promise<ApprovalRow | null> {
  const { data } = await createServiceRoleClient().from("infrastructure_approval_requests").select("id,status,operation,entity_id,expires_at").eq("workspace_id", workspaceId).eq("id", requestId).maybeSingle();
  return data ?? null;
}

/** Records a schema deployment, the environment's deployed schema and the approval marked executed. */
export async function recordSchemaDeployment(input: SchemaDeployment): Promise<void> {
  const db = createServiceRoleClient();
  await db.from("environment_schema_deployments").insert(input.row);
  await db.from("workspace_environments").update(input.environmentPatch).eq("workspace_id", input.workspaceId).eq("id", input.environmentId);
  await markApprovalExecuted(input.workspaceId, input.approvalRequestId);
}

/** The connection and environment rows a backup manifest lists (no credentials). */
export async function backupSources(workspaceId: string): Promise<{ connections: any[]; environments: any[] }> {
  const db = createServiceRoleClient();
  const connectionRows = await db.from("workspace_connections").select("id,environment_id,connector_type,connector_family,name,status,active,config_json,metadata_json,legacy_resource_type,legacy_resource_id,created_at,updated_at").eq("workspace_id", workspaceId);
  const environments = await db.from("workspace_environments").select("id,key,name,kind,status,is_default,cms_base_url,public_site_urls,database_provider,storage_provider,runtime_provider,deployed_schema_hash,deployed_schema_revision,config_json,created_at,updated_at").eq("workspace_id", workspaceId);
  return { connections: connectionRows.data ?? [], environments: environments.data ?? [] };
}

export async function insertBackup(row: Record<string, unknown>, audit: (backupId: string) => PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("workspace_backups").insert(row).select(BACKUP_SUMMARY).single();
  if (error || !data) throw new Error(error?.message || "Could not create backup");
  await logPlatformEvent(audit((data as any).id));
  return data;
}

export async function backupRow(workspaceId: string, backupId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("workspace_backups").select("*").eq("workspace_id", workspaceId).eq("id", backupId).maybeSingle();
  return data ?? null;
}

export async function insertRestoreRun(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("workspace_restore_runs").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not record restore run");
  return data;
}

export async function portabilityRows(workspaceId: string, environmentId: string): Promise<{ connections: any[]; components: any[]; refs: any[]; assets: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: connections }, { data: components }, { data: refs }, { data: assets }] = await Promise.all([
    db.from("workspace_connections").select("id,name,connector_type,connector_family,status,legacy_resource_type").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("environment_components").select("component_key,provider,state,required").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("workspace_secret_refs").select("id,state,provider_id").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("assets").select("id,storage_provider,storage_key,archived_at").eq("workspace_id", workspaceId),
  ]);
  return { connections: connections ?? [], components: components ?? [], refs: refs ?? [], assets: assets ?? [] };
}

export async function runtimeState(): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("cms_runtime_state").select("*").eq("singleton", true).maybeSingle();
  return data ?? null;
}

export async function insertUpgradeRun(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("environment_upgrade_runs").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not create upgrade plan");
  return data;
}

export async function upgradeRun(workspaceId: string, environmentId: string, runId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("environment_upgrade_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", runId).maybeSingle();
  return data ?? null;
}

export async function verifiedBackup(workspaceId: string, backupId: string): Promise<{ id: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("workspace_backups").select("id,status").eq("workspace_id", workspaceId).eq("id", backupId).eq("status", "verified").maybeSingle();
  return data ?? null;
}

/** Completes an upgrade run and marks its approval executed when it succeeded. */
export async function completeUpgrade(input: UpgradeCompletion): Promise<any> {
  const { data: updated } = await createServiceRoleClient().from("environment_upgrade_runs").update(input.patch).eq("id", input.runId).select().single();
  await markApprovalExecuted(input.workspaceId, input.approvalRequestId);
  return updated;
}

export async function websiteBinding(workspaceId: string, environmentId: string, connectionId: string): Promise<{ id: string; publication_target_id: string | null } | null> {
  const { data } = await createServiceRoleClient().from("website_connection_bindings").select("id,publication_target_id").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("connection_id", connectionId).maybeSingle();
  return data ?? null;
}

/** Creates the connection-backed publication target when there is none, then upserts the binding. */
export async function bindWebsite(input: WebsiteBinding): Promise<any> {
  const db = createServiceRoleClient();
  let targetId = (input.binding.publication_target_id as string | null) ?? null;
  if (input.newTarget) {
    const { data: target, error: targetError } = await db.from("publication_targets").insert(input.newTarget).select("id").single();
    if (targetError || !target) throw new Error(targetError?.message || "Could not create connection-backed publication target");
    targetId = target.id;
  }
  const { data, error } = await db.from("website_connection_bindings").upsert({ ...input.binding, publication_target_id: targetId }, { onConflict: "environment_id,connection_id" }).select().single();
  if (error || !data) throw new Error(error?.message || "Could not bind website connection");
  return data;
}

export async function websiteBindingById(workspaceId: string, bindingId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("website_connection_bindings").select("*").eq("workspace_id", workspaceId).eq("id", bindingId).maybeSingle();
  return data ?? null;
}

export async function markWebsiteTesting(workspaceId: string, bindingId: string, jobId: string): Promise<void> {
  void workspaceId; // the binding was just read from the workspace
  await createServiceRoleClient().from("website_connection_bindings").update({ status: "testing", last_test_job_id: jobId, last_test_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", bindingId);
}

export async function requestApproval(args: RequestApprovalArgs): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_request_infrastructure_approval", args);
  if (error || !data) throw new Error(error?.message || "Could not request approval");
  return data;
}

/** Reviews an approval request. Throws with a status: 403 when the requester reviews their own request. */
export async function reviewApproval(args: ReviewApprovalArgs): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_review_infrastructure_approval", args);
  if (error || !data) throw Object.assign(new Error(error?.message || "Could not review approval"), { status: error?.code === "40300" ? 403 : 400 });
  return data;
}

export async function componentRow(workspaceId: string, environmentId: string, componentId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("environment_components").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", componentId).maybeSingle();
  return data ?? null;
}

/** Records a component action, the component's new state and the approval marked executed. */
export async function recordComponentRun(input: ComponentRun): Promise<any> {
  const db = createServiceRoleClient();
  const { data: run, error } = await db.from("environment_component_runs").insert(input.run).select().single();
  if (error || !run) throw new Error(error?.message || "Could not record component action");
  await db.from("environment_components").update(input.componentPatch).eq("id", input.componentId);
  await markApprovalExecuted(input.workspaceId, input.approvalRequestId);
  return run;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
