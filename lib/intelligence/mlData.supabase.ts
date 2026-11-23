// Supabase path of the operational ML reads and writes (queries moved unchanged from
// operationalMlService.ts; deleted with the switch at the end of phase 1). The learning policy
// rules, feature computation, trainers, integrity checks and prediction rules stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type LocalEventRow = { id: string; event_type: string; occurred_at: string; features_json: any; outcome_json: any };

/** The workspace's learning policy, created with its defaults when there is none. */
export async function learningPolicy(workspaceId: string): Promise<any> {
  const db = createServiceRoleClient();
  const { data: existing, error } = await db.from("operational_learning_policies").select("*").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing;
  const { data, error: createError } = await db.from("operational_learning_policies").insert({ workspace_id: workspaceId }).select().single();
  if (createError || !data) throw new Error(createError?.message || "Could not initialize operational learning policy");
  return data;
}

export async function saveLearningPolicy(row: Record<string, unknown>, auditFor: (policy: any) => PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("operational_learning_policies").upsert(row, { onConflict: "workspace_id" }).select().single();
  if (error || !data) throw new Error(error?.message || "Could not update operational learning policy");
  await logPlatformEvent(auditFor(data));
  return data;
}

/** Upserts the workspace's model definitions and returns its registry by family. */
export async function ensureRegistry(workspaceId: string, rows: Array<Record<string, unknown>>): Promise<any[]> {
  const db = createServiceRoleClient();
  for (const row of rows) {
    const { error } = await db.from("operational_model_registry").upsert(row, { onConflict: "workspace_id,model_key" });
    if (error) throw new Error(error.message);
  }
  const { data, error } = await db.from("operational_model_registry").select("*").eq("workspace_id", workspaceId).order("model_family");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Events eligible for local learning since `start`, oldest first (at most 10000). */
export async function localEvents(workspaceId: string, environmentId: string, start: string): Promise<LocalEventRow[]> {
  const { data, error } = await createServiceRoleClient().from("operational_events")
    .select("id,event_type,occurred_at,features_json,outcome_json")
    .eq("workspace_id", workspaceId)
    .eq("environment_id", environmentId)
    .eq("eligible_for_local_learning", true)
    .gte("occurred_at", start)
    .order("occurred_at", { ascending: true })
    .limit(10000);
  if (error) throw new Error(error.message);
  return (data ?? []) as LocalEventRow[];
}

/** The environment, its world nodes and its open drift, for a feature snapshot. */
export async function snapshotInputs(workspaceId: string, environmentId: string): Promise<{ environment: { kind: string; status: string } | null; worldNodes: Array<{ state: string; is_stale: boolean; node_type: string }>; drifts: Array<{ severity: string; state: string; category: string; action_class: string }> }> {
  const db = createServiceRoleClient();
  const [{ data: environment }, { data: worldNodes }, { data: drifts }] = await Promise.all([
    db.from("workspace_environments").select("kind,status").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle(),
    db.from("operational_world_nodes").select("state,is_stale,node_type").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("operational_drift_items").select("severity,state,category,action_class").eq("workspace_id", workspaceId).eq("environment_id", environmentId).in("state", ["open", "acknowledged", "planned"]),
  ]);
  return { environment: environment ?? null, worldNodes: worldNodes ?? [], drifts: drifts ?? [] };
}

export async function insertSnapshot(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("operational_feature_snapshots").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not persist operational feature snapshot");
  return data;
}

/**
 * Persists the model's next version (number = latest + 1, `rowFor` builds it from that number),
 * deploys it in place of the current deployed version when `deploy` is set, and records its
 * evaluations. Returns the finalized version.
 */
export async function persistModelVersion(workspaceId: string, modelId: string, rowFor: (version: number) => Record<string, unknown>, deploy: boolean, evaluationsFor: (versionId: string) => Array<Record<string, unknown>>): Promise<any> {
  void workspaceId; // the caller read the model in the workspace
  const db = createServiceRoleClient();
  const { data: latest } = await db.from("operational_model_versions").select("version").eq("model_id", modelId).order("version", { ascending: false }).limit(1).maybeSingle();
  const version = Number(latest?.version ?? 0) + 1;
  const { data, error } = await db.from("operational_model_versions").insert(rowFor(version)).select().single();
  if (error || !data) throw new Error(error?.message || "Could not persist model version");
  const status = deploy ? "deployed" : "candidate";
  if (deploy) await db.from("operational_model_versions").update({ status: "retired" }).eq("model_id", modelId).eq("status", "deployed");
  const { data: updated, error: updateError } = await db.from("operational_model_versions").update({ status, deployed_at: deploy ? new Date().toISOString() : null }).eq("id", data.id).select().single();
  if (updateError || !updated) throw new Error(updateError?.message || "Could not finalize model version");
  await db.from("operational_model_evaluations").insert(evaluationsFor(data.id));
  return updated;
}

/** The workspace's enabled model of a family and that model's deployed version. */
export async function deployedModelRows(workspaceId: string, family: string): Promise<{ model: any | null; version: any | null }> {
  const db = createServiceRoleClient();
  const { data: model } = await db.from("operational_model_registry").select("*").eq("workspace_id", workspaceId).eq("model_family", family).eq("enabled", true).maybeSingle();
  if (!model) return { model: null, version: null };
  const { data: version } = await db.from("operational_model_versions").select("*").eq("model_id", model.id).eq("status", "deployed").maybeSingle();
  return { model, version: version ?? null };
}

/** Withdraws a deployed version whose integrity check failed. */
export async function failDeployedVersion(workspaceId: string, versionId: string): Promise<void> {
  void workspaceId; // the caller read the version through the workspace's model
  await createServiceRoleClient().from("operational_model_versions").update({ status: "failed" }).eq("id", versionId).eq("status", "deployed");
}

export async function insertPrediction(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("operational_predictions").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not persist operational prediction");
  return data;
}

export async function planForPrediction(workspaceId: string, environmentId: string, planId: string): Promise<any | null> {
  const { data: plan } = await createServiceRoleClient().from("operational_change_plans").select("id,deterministic_classification,requires_approval,immutable_plan_json,plan_checksum_sha256,source_discovery_run_id,created_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", planId).maybeSingle();
  return plan ?? null;
}

export async function overviewRows(workspaceId: string, environmentId: string): Promise<{ modelVersions: any[]; predictions: any[]; featureSnapshots: any[]; evaluations: any[] }> {
  const db = createServiceRoleClient();
  const [versions, predictions, snapshots, evaluations] = await Promise.all([
    db.from("operational_model_versions").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(100),
    db.from("operational_predictions").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("created_at", { ascending: false }).limit(100),
    db.from("operational_feature_snapshots").select("id,feature_family,sample_support,checksum_sha256,captured_at,expires_at,provenance_json").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("captured_at", { ascending: false }).limit(50),
    db.from("operational_model_evaluations").select("*").eq("workspace_id", workspaceId).order("evaluated_at", { ascending: false }).limit(100),
  ]);
  return { modelVersions: versions.data ?? [], predictions: predictions.data ?? [], featureSnapshots: snapshots.data ?? [], evaluations: evaluations.data ?? [] };
}

/** Predictions made for a plan, newest first. */
export async function planPredictions(workspaceId: string, environmentId: string, planId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("operational_predictions").select("id,prediction_key,status,probability,estimate,interval_lower,interval_upper,model_id,model_version_id").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("subject_type", "operational_change_plan").eq("subject_id", planId).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertOutcomes(rows: Array<Record<string, unknown>>): Promise<void> {
  if (!rows.length) return;
  const { error } = await createServiceRoleClient().from("operational_prediction_outcomes").upsert(rows, { onConflict: "prediction_id" });
  if (error) throw new Error(error.message);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
