// Supabase path of the content-health reads and writes (queries moved unchanged from
// healthService.ts; deleted with the switch at the end of phase 1). The scan rules, the summary and
// the remediation patch rules stay in healthService.ts and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export async function callUpsertHealthFinding(args: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_upsert_health_finding", args);
  if (error) throw new Error(error.message);
  return data;
}

/** Health profiles and live (not archived) assets, for a scan. */
export async function scanRows(workspaceId: string): Promise<{ profiles: any[]; assets: Array<{ id: string; filename: string; mime_type: string | null; archived_at: string | null }> }> {
  const db = createServiceRoleClient();
  const [profilesResult, assetsResult] = await Promise.all([
    db.from("content_health_profiles").select("*").eq("workspace_id", workspaceId),
    db.from("assets").select("id, filename, mime_type, archived_at").eq("workspace_id", workspaceId).is("archived_at", null),
  ]);
  return { profiles: profilesResult.data ?? [], assets: assetsResult.data ?? [] };
}

/** Resolves the open or acknowledged findings whose fingerprint was not detected; returns how many. */
export async function resolveUndetected(workspaceId: string, detected: Set<string>): Promise<number> {
  const db = createServiceRoleClient();
  const { data: openFindings } = await db.from("content_health_findings").select("id, fingerprint, state").eq("workspace_id", workspaceId).in("state", ["open", "acknowledged"]);
  const resolvedIds = (openFindings ?? []).filter((finding) => !detected.has(finding.fingerprint)).map((finding) => finding.id);
  if (resolvedIds.length) {
    await db.from("content_health_findings").update({ state: "resolved", resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in("id", resolvedIds).eq("workspace_id", workspaceId);
  }
  return resolvedIds.length;
}

export async function overviewRows(workspaceId: string): Promise<{ findings: any[]; tasks: any[]; profiles: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: findings }, { data: tasks }, { data: profiles }] = await Promise.all([
    db.from("content_health_findings").select("*").eq("workspace_id", workspaceId).order("last_detected_at", { ascending: false }),
    db.from("content_remediation_tasks").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }),
    db.from("content_health_profiles").select("*").eq("workspace_id", workspaceId),
  ]);
  return { findings: findings ?? [], tasks: tasks ?? [], profiles: profiles ?? [] };
}

export async function insertRemediationTask(row: Record<string, unknown>, auditFor: (task: any) => PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("content_remediation_tasks").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not create remediation task");
  await logPlatformEvent(auditFor(data));
  return data;
}

/** Updates a task of the workspace; null when there is none. */
export async function updateRemediationTaskRow(workspaceId: string, id: string, patch: Record<string, unknown>, auditFor: (task: any) => PlatformAuditPayload): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("content_remediation_tasks").update(patch).eq("workspace_id", workspaceId).eq("id", id).select().maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  await logPlatformEvent(auditFor(data));
  return data;
}

export async function callUpsertHealthProfile(args: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_upsert_content_health_profile", args);
  if (error || !data) throw new Error(error?.message || "Could not update content health profile");
  return data;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
