// Supabase path of the deterministic remediation reads and writes (queries moved unchanged from
// remediationService.ts; deleted with the switch at the end of phase 1). The registry rules, the
// policy gates, the executors and the verification stay in remediationService.ts.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export async function enabledRegistry(): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("operational_remediation_registry").select("*").eq("enabled", true).order("remediation_key");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function registryEntry(remediationKey: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("operational_remediation_registry").select("*").eq("remediation_key", remediationKey).eq("enabled", true).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** Whether the drift item belongs to the workspace's environment. */
export async function driftInEnvironment(workspaceId: string, environmentId: string, driftItemId: string): Promise<boolean> {
  const { data } = await createServiceRoleClient().from("operational_drift_items").select("id").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", driftItemId).maybeSingle();
  return Boolean(data);
}

export async function startRun(row: Record<string, unknown>): Promise<any> {
  const { data: run, error } = await createServiceRoleClient().from("operational_remediation_runs").insert(row).select().single();
  if (error || !run) throw new Error(error?.message || "Could not start remediation run");
  return run;
}

/** Completes a run of the workspace, records its outcome event and the audit event. */
export async function completeRun(workspaceId: string, runId: string, patch: Record<string, unknown>, outcomeEvent: Record<string, unknown>, auditFor: (run: any) => PlatformAuditPayload): Promise<any> {
  void workspaceId; // the caller started the run in the workspace
  const db = createServiceRoleClient();
  const { data: completed, error } = await db.from("operational_remediation_runs").update(patch).eq("id", runId).select().single();
  if (error || !completed) throw new Error(error?.message || "Could not finalize remediation run");
  await db.from("operational_events").insert({ ...outcomeEvent, source_id: completed.id });
  await logPlatformEvent(auditFor(completed));
  return completed;
}

/** Marks a run of the workspace failed and records its outcome event. */
export async function failRun(workspaceId: string, runId: string, patch: Record<string, unknown>, outcomeEvent: Record<string, unknown>): Promise<void> {
  void workspaceId; // the caller started the run in the workspace
  const db = createServiceRoleClient();
  await db.from("operational_remediation_runs").update(patch).eq("id", runId);
  await db.from("operational_events").insert({ ...outcomeEvent, source_id: runId });
}

/** Open safe-auto-repair drift items of a desired state, and the environment's world nodes. */
export async function autoRepairRows(workspaceId: string, environmentId: string, desiredStateRevisionId: string): Promise<{ drifts: any[]; nodes: Array<{ id: string; source_entity_id: string | null }> }> {
  const db = createServiceRoleClient();
  const [{ data: drifts }, { data: nodes }] = await Promise.all([
    db.from("operational_drift_items").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("desired_state_revision_id", desiredStateRevisionId).eq("state", "open").eq("action_class", "safe_auto_repair").order("severity"),
    db.from("operational_world_nodes").select("id,source_entity_id").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
  ]);
  return { drifts: drifts ?? [], nodes: nodes ?? [] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
