// Supabase path of the desired-state and reconciliation reads and writes (queries moved unchanged
// from reconciliationService.ts; deleted with the switch at the end of phase 1). Desired-state
// validation and drift calculation stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ReconciliationCompletion = { status: string; summary_json: Record<string, unknown>; completed_at: string };

export async function listRevisions(workspaceId: string, environmentId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("operational_desired_state_revisions").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("revision", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function activeRevision(workspaceId: string, environmentId: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("operational_desired_state_revisions").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("status", "active").maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function revisionById(workspaceId: string, environmentId: string, revisionId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("operational_desired_state_revisions").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", revisionId).maybeSingle();
  return data ?? null;
}

export async function revisionByChecksum(workspaceId: string, environmentId: string, checksum: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("operational_desired_state_revisions").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("checksum_sha256", checksum).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** Creates the environment's next desired-state revision (number = latest + 1) with its audit event. */
export async function createRevision(row: Record<string, unknown> & { workspace_id: string; environment_id: string }, auditFor: (revision: any) => PlatformAuditPayload): Promise<any> {
  const db = createServiceRoleClient();
  const { data: latest, error: latestError } = await db.from("operational_desired_state_revisions").select("revision").eq("workspace_id", row.workspace_id).eq("environment_id", row.environment_id).order("revision", { ascending: false }).limit(1).maybeSingle();
  if (latestError) throw new Error(latestError.message);
  const revision = Number(latest?.revision ?? 0) + 1;
  const { data: created, error } = await db.from("operational_desired_state_revisions").insert({ ...row, revision }).select().single();
  if (error || !created) throw new Error(error?.message || "Could not create desired-state revision");
  await logPlatformEvent(auditFor(created));
  return created;
}

export async function callActivateRevision(args: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_activate_operational_desired_state", args);
  if (error || !data) throw Object.assign(new Error(error?.message || "Could not activate desired-state revision"), { status: error?.code === "P0002" ? 404 : 400 });
  return data;
}

export async function environmentState(workspaceId: string, environmentId: string): Promise<{ id: string; kind: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("workspace_environments").select("id,kind,status").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  return data ?? null;
}

export async function startReconciliation(row: Record<string, unknown>): Promise<any> {
  const { data: run, error } = await createServiceRoleClient().from("operational_reconciliation_runs").insert(row).select().single();
  if (error || !run) throw new Error(error?.message || "Could not start reconciliation");
  return run;
}

/**
 * Records a reconciliation's drift: upserts the current drift items, resolves the revision's open
 * items that are no longer drifting, completes the run and writes the audit event.
 */
export async function applyReconciliation(params: {
  workspaceId: string; environmentId: string; revisionId: string; runId: string; rows: Array<Record<string, unknown>>; currentKeys: Set<string>; now: string;
  completion: (resolved: number) => ReconciliationCompletion; auditFor: (completed: any, resolved: number) => PlatformAuditPayload;
}): Promise<{ completed: any; resolved: number }> {
  const db = createServiceRoleClient();
  if (params.rows.length) {
    const { error } = await db.from("operational_drift_items").upsert(params.rows, { onConflict: "environment_id,desired_state_revision_id,drift_key" });
    if (error) throw new Error(error.message);
  }
  const { data: prior, error: priorError } = await db.from("operational_drift_items")
    .select("id,drift_key,state")
    .eq("workspace_id", params.workspaceId)
    .eq("environment_id", params.environmentId)
    .eq("desired_state_revision_id", params.revisionId)
    .in("state", ["open", "acknowledged", "planned"]);
  if (priorError) throw new Error(priorError.message);
  const resolvedIds = (prior ?? []).filter((item) => !params.currentKeys.has(item.drift_key)).map((item) => item.id);
  for (const id of resolvedIds) {
    const { error } = await db.from("operational_drift_items").update({ state: "resolved", resolved_at: params.now, last_seen_at: params.now }).eq("id", id);
    if (error) throw new Error(error.message);
  }
  const { data: completed, error: completeError } = await db.from("operational_reconciliation_runs").update(params.completion(resolvedIds.length)).eq("id", params.runId).select().single();
  if (completeError || !completed) throw new Error(completeError?.message || "Could not complete reconciliation");
  await logPlatformEvent(params.auditFor(completed, resolvedIds.length));
  return { completed, resolved: resolvedIds.length };
}

export async function failReconciliation(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  void workspaceId; // the caller started the run in the workspace
  await createServiceRoleClient().from("operational_reconciliation_runs").update(patch).eq("id", runId);
}

export async function listDrift(workspaceId: string, environmentId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("operational_drift_items").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("last_seen_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
