// PostgreSQL implementation of the ML governance and predictive plan comparison reads and writes
// (phase 1, wave 4). Deliberate differences from the Supabase path it replaced in phase 1:
// - Retention deletes the four kinds of expired learning data in one transaction, so a failure
// cannot leave some kinds deleted and others kept.
// - Feedback, comparisons and scenario selection commit with their audit events; the selection
// update is scoped by workspace_id as well as id.
// - Plan nodes are read through their plan's workspace (operational_change_plan_nodes has no
// workspace_id); the feedback list is one join instead of an id list.
// - Lists keep their limits and gain an id tie-break; jsonb values are serialized explicitly;
// database text never reaches the caller.
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export type RetentionCounts = { featureSnapshots: number; predictions: number; operationalEvents: number; evaluations: number };


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));
const JSON_COLUMNS = ["metadata_json", "metrics_json", "distribution_json", "comparison_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;

async function guarded<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(clientErrorMessage(error, fallback));
  }
}

export async function deleteExpiredLearningData(workspaceId: string, cutoff: string): Promise<RetentionCounts> {
  return guarded("Could not apply the learning data retention policy", () => withTransaction(async (trx) => {
    const count = (result: { numDeletedRows: bigint }) => Number(result.numDeletedRows);
    const featureSnapshots = count(await trx.deleteFrom("operational_feature_snapshots").where("workspace_id", "=", workspaceId).where("captured_at", "<", cutoff).executeTakeFirst());
    const predictions = count(await trx.deleteFrom("operational_predictions").where("workspace_id", "=", workspaceId).where("created_at", "<", cutoff).executeTakeFirst());
    const operationalEvents = count(await trx.deleteFrom("operational_events").where("workspace_id", "=", workspaceId).where("occurred_at", "<", cutoff).executeTakeFirst());
    const evaluations = count(await trx.deleteFrom("operational_model_evaluations").where("workspace_id", "=", workspaceId).where("evaluated_at", "<", cutoff).executeTakeFirst());
    return { featureSnapshots, predictions, operationalEvents, evaluations };
  }));
}

export async function predictionForFeedback(workspaceId: string, predictionId: string): Promise<any | null> {
  if (!ids(predictionId)) return null;
  return (await getDb().selectFrom("operational_predictions").select(["id", "environment_id", "status", "model_id", "model_version_id", "feature_snapshot_id"])
    .where("workspace_id", "=", workspaceId).where("id", "=", predictionId).executeTakeFirst()) ?? null;
}

export async function insertFeedback(row: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  return guarded("Could not record prediction feedback", () => withTransaction(async (trx) => {
    const feedback = await trx.insertInto("operational_prediction_feedback").values(json(row)).returningAll().executeTakeFirstOrThrow();
    await recordPlatformEvent(trx, audit);
    return feedback;
  }));
}

export async function evaluationInputs(workspaceId: string, environmentId: string): Promise<{ predictions: any[]; outcomes: any[] }> {
  if (!ids(environmentId)) return { predictions: [], outcomes: [] };
  const db = getDb();
  const predictions = await db.selectFrom("operational_predictions").select(["id", "prediction_key", "model_version_id", "probability", "estimate", "interval_lower", "interval_upper"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("model_version_id", "is not", null)
    .orderBy("created_at", "desc").orderBy("id").limit(1000).execute();
  if (!predictions.length) return { predictions: [], outcomes: [] };
  const outcomes = await db.selectFrom("operational_prediction_outcomes").select(["prediction_id", "outcome_json", "evaluation_json", "observed_at"])
    .where("workspace_id", "=", workspaceId).where("prediction_id", "in", predictions.map((row) => row.id)).execute();
  return { predictions, outcomes };
}

export async function insertEvaluation(row: Record<string, unknown>): Promise<any> {
  return guarded("Could not persist online model evaluation", () => getDb().insertInto("operational_model_evaluations").values(json(row)).returningAll().executeTakeFirstOrThrow());
}

export async function feedbackFor(workspaceId: string, environmentId: string): Promise<any[]> {
  if (!ids(environmentId)) return [];
  return getDb().selectFrom("operational_prediction_feedback as f").innerJoin("operational_predictions as p", "p.id", "f.prediction_id")
    .selectAll("f").where("f.workspace_id", "=", workspaceId).where("p.workspace_id", "=", workspaceId).where("p.environment_id", "=", environmentId)
    .orderBy("f.created_at", "desc").orderBy("f.id").limit(100).execute();
}

export async function planWithNodes(workspaceId: string, environmentId: string, planId: string): Promise<{ plan: any | null; nodes: any[] }> {
  if (!ids(environmentId, planId)) return { plan: null, nodes: [] };
  const db = getDb();
  const plan = await db.selectFrom("operational_change_plans").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", planId).executeTakeFirst();
  if (!plan) return { plan: null, nodes: [] };
  const nodes = await db.selectFrom("operational_change_plan_nodes").selectAll().where("plan_id", "=", plan.id).orderBy("ordinal").orderBy("id").execute();
  return { plan, nodes };
}

export async function insertComparison(row: Record<string, unknown>, auditFor: (comparison: any) => PlatformAuditPayload): Promise<any> {
  return guarded("Could not persist operational plan comparison", () => withTransaction(async (trx) => {
    const comparison = await trx.insertInto("operational_plan_comparisons").values(json(row)).returningAll().executeTakeFirstOrThrow();
    await recordPlatformEvent(trx, auditFor(comparison));
    return comparison;
  }));
}

export async function comparisonById(workspaceId: string, environmentId: string, comparisonId: string): Promise<any | null> {
  if (!ids(environmentId, comparisonId)) return null;
  return (await getDb().selectFrom("operational_plan_comparisons").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", comparisonId).executeTakeFirst()) ?? null;
}

export async function selectScenario(workspaceId: string, comparisonId: string, patch: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  return guarded("Could not record selected plan scenario", () => withTransaction(async (trx) => {
    const comparison = await trx.updateTable("operational_plan_comparisons").set(json(patch)).where("workspace_id", "=", workspaceId).where("id", "=", comparisonId).returningAll().executeTakeFirst();
    if (!comparison) throw new Error("Could not record selected plan scenario");
    await recordPlatformEvent(trx, audit);
    return comparison;
  }));
}

export async function listComparisons(workspaceId: string, environmentId: string): Promise<any[]> {
  if (!ids(environmentId)) return [];
  return getDb().selectFrom("operational_plan_comparisons").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
    .orderBy("created_at", "desc").orderBy("id").limit(100).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
