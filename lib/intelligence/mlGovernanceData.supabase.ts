// Supabase path of the ML governance (retention, feedback, online evaluation) and predictive plan
// comparison reads and writes (queries moved unchanged from operationalMlGovernanceService.ts and
// predictivePlanningService.ts; deleted with the switch at the end of phase 1). Metrics, scenario
// building and ranking stay in those services; model and prediction rows go through mlData.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export type RetentionCounts = { featureSnapshots: number; predictions: number; operationalEvents: number; evaluations: number };

/** Deletes the workspace's learning data older than the cutoff; returns how many rows of each kind went. */
export async function deleteExpiredLearningData(workspaceId: string, cutoff: string): Promise<RetentionCounts> {
  const db = createServiceRoleClient();
  const [snapshots, predictions, events, evaluations] = await Promise.all([
    db.from("operational_feature_snapshots").delete().eq("workspace_id", workspaceId).lt("captured_at", cutoff).select("id"),
    db.from("operational_predictions").delete().eq("workspace_id", workspaceId).lt("created_at", cutoff).select("id"),
    db.from("operational_events").delete().eq("workspace_id", workspaceId).lt("occurred_at", cutoff).select("id"),
    db.from("operational_model_evaluations").delete().eq("workspace_id", workspaceId).lt("evaluated_at", cutoff).select("id"),
  ]);
  for (const result of [snapshots, predictions, events, evaluations]) if (result.error) throw new Error(result.error.message);
  return { featureSnapshots: snapshots.data?.length ?? 0, predictions: predictions.data?.length ?? 0, operationalEvents: events.data?.length ?? 0, evaluations: evaluations.data?.length ?? 0 };
}

export async function predictionForFeedback(workspaceId: string, predictionId: string): Promise<any | null> {
  const { data: prediction } = await createServiceRoleClient().from("operational_predictions").select("id,environment_id,status,model_id,model_version_id,feature_snapshot_id").eq("workspace_id", workspaceId).eq("id", predictionId).maybeSingle();
  return prediction ?? null;
}

export async function insertFeedback(row: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("operational_prediction_feedback").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not record prediction feedback");
  await logPlatformEvent(audit);
  return data;
}

/** The environment's latest 1000 model predictions, and the outcomes recorded for them. */
export async function evaluationInputs(workspaceId: string, environmentId: string): Promise<{ predictions: any[]; outcomes: any[] }> {
  const db = createServiceRoleClient();
  const { data: predictions, error } = await db.from("operational_predictions")
    .select("id,prediction_key,model_version_id,probability,estimate,interval_lower,interval_upper")
    .eq("workspace_id", workspaceId)
    .eq("environment_id", environmentId)
    .not("model_version_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  const ids = (predictions ?? []).map((row) => row.id);
  if (!ids.length) return { predictions: [], outcomes: [] };
  const { data: outcomes, error: outcomeError } = await db.from("operational_prediction_outcomes").select("prediction_id,outcome_json,evaluation_json,observed_at").eq("workspace_id", workspaceId).in("prediction_id", ids);
  if (outcomeError) throw new Error(outcomeError.message);
  return { predictions: predictions ?? [], outcomes: outcomes ?? [] };
}

export async function insertEvaluation(row: Record<string, unknown>): Promise<any> {
  const { data: evaluation, error } = await createServiceRoleClient().from("operational_model_evaluations").insert(row).select().single();
  if (error || !evaluation) throw new Error(error?.message || "Could not persist online model evaluation");
  return evaluation;
}

/** Feedback on the environment's predictions (from its latest 500), newest first, at most 100. */
export async function feedbackFor(workspaceId: string, environmentId: string): Promise<any[]> {
  const db = createServiceRoleClient();
  const { data: predictions } = await db.from("operational_predictions").select("id").eq("workspace_id", workspaceId).eq("environment_id", environmentId).limit(500);
  const ids = (predictions ?? []).map((item) => item.id);
  if (!ids.length) return [];
  const { data, error } = await db.from("operational_prediction_feedback").select("*").eq("workspace_id", workspaceId).in("prediction_id", ids).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** A plan of the workspace's environment and its nodes in order. */
export async function planWithNodes(workspaceId: string, environmentId: string, planId: string): Promise<{ plan: any | null; nodes: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: plan }, { data: nodes }] = await Promise.all([
    db.from("operational_change_plans").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", planId).maybeSingle(),
    db.from("operational_change_plan_nodes").select("*").eq("plan_id", planId).order("ordinal"),
  ]);
  return { plan: plan ?? null, nodes: plan ? nodes ?? [] : [] };
}

export async function insertComparison(row: Record<string, unknown>, auditFor: (comparison: any) => PlatformAuditPayload): Promise<any> {
  const { data: comparison, error } = await createServiceRoleClient().from("operational_plan_comparisons").insert(row).select().single();
  if (error || !comparison) throw new Error(error?.message || "Could not persist operational plan comparison");
  await logPlatformEvent(auditFor(comparison));
  return comparison;
}

export async function comparisonById(workspaceId: string, environmentId: string, comparisonId: string): Promise<any | null> {
  const { data: comparison } = await createServiceRoleClient().from("operational_plan_comparisons").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", comparisonId).maybeSingle();
  return comparison ?? null;
}

export async function selectScenario(workspaceId: string, comparisonId: string, patch: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  void workspaceId; // the caller read the comparison in the workspace
  const { data, error } = await createServiceRoleClient().from("operational_plan_comparisons").update(patch).eq("id", comparisonId).select().single();
  if (error || !data) throw new Error(error?.message || "Could not record selected plan scenario");
  await logPlatformEvent(audit);
  return data;
}

export async function listComparisons(workspaceId: string, environmentId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("operational_plan_comparisons").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
