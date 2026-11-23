// Supabase path of the data-aware change assessment reads and writes (queries moved from
// migrationIntelligenceService.ts; deleted with the switch at the end of phase 1). One change: the
// target version is read through its model's workspace. Profiling the customer database, the
// classification and the provenance rules stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type TargetVersionRow = { id: string; version_number: number; schema_hash: string; schema_json: any };
export type SourceDeploymentRow = { id: string; schema_version: number; schema_hash: string; status: string; deployed_at: string; metadata_json: any };

/**
 * The model's newest version with the target schema hash, and the environment's latest deployed (or
 * drifted) deployment of the model. The caller resolved the model in the workspace.
 */
export async function assessmentSources(workspaceId: string, environmentId: string, modelId: string, targetHash: string): Promise<{ targetVersion: TargetVersionRow | null; sourceDeployment: SourceDeploymentRow | null }> {
  const db = createServiceRoleClient();
  const [{ data: targetVersion }, { data: sourceDeployment }] = await Promise.all([
    // Scoped through the model's workspace (one change from the moved query, which read by model id alone).
    db.from("content_model_versions").select("id,version_number,schema_hash,schema_json,content_models!inner(workspace_id)").eq("content_models.workspace_id", workspaceId).eq("content_model_id", modelId).eq("schema_hash", targetHash).order("version_number", { ascending: false }).limit(1).maybeSingle(),
    db.from("environment_schema_deployments").select("id,schema_version,schema_hash,status,deployed_at,metadata_json").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("content_model_id", modelId).in("status", ["deployed", "drifted"]).order("deployed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const version = targetVersion ? (({ content_models: _model, ...rest }: any) => rest)(targetVersion) : null;
  return { targetVersion: (version as TargetVersionRow | null) ?? null, sourceDeployment: (sourceDeployment as SourceDeploymentRow | null) ?? null };
}

/** Persists an assessment with its operational event and audit event. */
export async function recordAssessment(row: Record<string, unknown>, event: Record<string, unknown>, auditFor: (assessment: any) => PlatformAuditPayload): Promise<any> {
  const db = createServiceRoleClient();
  const { data: persisted, error } = await db.from("operational_change_assessments").insert(row).select().single();
  if (error || !persisted) throw new Error(error?.message || "Could not persist data-aware change assessment");
  await db.from("operational_events").insert({ ...event, source_id: persisted.id });
  await logPlatformEvent(auditFor(persisted));
  return persisted;
}

export async function listAssessments(workspaceId: string, environmentId: string, modelId?: string | null): Promise<any[]> {
  let query = createServiceRoleClient().from("operational_change_assessments").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId);
  if (modelId) query = query.eq("content_model_id", modelId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
