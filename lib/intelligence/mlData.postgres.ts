// Direct PostgreSQL implementation of the operational ML reads and writes (phase 1, wave 4). Same
// signatures and shapes as mlData.supabase.ts. Differences that are deliberate:
// - The learning policy is created with ON CONFLICT DO NOTHING, so two first reads cannot fail each
//   other on the unique key; the registry upserts commit together.
// - A model version takes its number under a lock on its registry row, and the version, the
//   retirement of the previous deployed version, deployment and its evaluations commit together
//   (the Supabase path could leave a model with no deployed version, or a version without
//   evaluations, when a later step failed).
// - Model versions are read and written through the workspace (operational_model_versions.workspace_id),
//   not by model id alone; prediction outcomes are only written for the workspace's own predictions.
// - Lists keep their limits and gain an id tie-break; jsonb values are serialized explicitly;
//   database text never reaches the caller.
import { sql } from "kysely";
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { LocalEventRow } from "@/lib/intelligence/mlData.supabase";

export type { LocalEventRow } from "@/lib/intelligence/mlData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));
const JSON_COLUMNS = ["settings_json", "feature_contract_json", "artifact_json", "calibration_json", "metrics_json", "features_json", "provenance_json", "explanation_json", "prediction_json", "evaluation_json", "outcome_json", "distribution_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;
const excluded = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.keys(row).filter((key) => !keys.includes(key)).map((key) => [key, sql.ref(`excluded.${key}`)])) as any;

async function guarded<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(clientErrorMessage(error, fallback));
  }
}

export async function learningPolicy(workspaceId: string): Promise<any> {
  return guarded("Could not initialize operational learning policy", async () => {
    const db = getDb();
    const existing = await db.selectFrom("operational_learning_policies").selectAll().where("workspace_id", "=", workspaceId).executeTakeFirst();
    if (existing) return existing;
    await db.insertInto("operational_learning_policies").values({ workspace_id: workspaceId }).onConflict((conflict) => conflict.column("workspace_id").doNothing()).execute();
    return db.selectFrom("operational_learning_policies").selectAll().where("workspace_id", "=", workspaceId).executeTakeFirstOrThrow();
  });
}

export async function saveLearningPolicy(row: Record<string, unknown>, auditFor: (policy: any) => PlatformAuditPayload): Promise<any> {
  return guarded("Could not update operational learning policy", () => withTransaction(async (trx) => {
    const policy = await trx.insertInto("operational_learning_policies").values(json(row))
      .onConflict((conflict) => conflict.column("workspace_id").doUpdateSet(excluded(row, ["workspace_id"]))).returningAll().executeTakeFirstOrThrow();
    await recordPlatformEvent(trx, auditFor(policy));
    return policy;
  }));
}

export async function ensureRegistry(workspaceId: string, rows: Array<Record<string, unknown>>): Promise<any[]> {
  return guarded("Could not update the operational model registry", async () => {
    if (rows.length) {
      await withTransaction(async (trx) => {
        for (const row of rows) {
          await trx.insertInto("operational_model_registry").values(json(row))
            .onConflict((conflict) => conflict.columns(["workspace_id", "model_key"]).doUpdateSet(excluded(row, ["workspace_id", "model_key"]))).execute();
        }
      });
    }
    return getDb().selectFrom("operational_model_registry").selectAll().where("workspace_id", "=", workspaceId).orderBy("model_family").orderBy("id").execute();
  });
}

export async function localEvents(workspaceId: string, environmentId: string, start: string): Promise<LocalEventRow[]> {
  if (!ids(environmentId)) return [];
  return await getDb().selectFrom("operational_events").select(["id", "event_type", "occurred_at", "features_json", "outcome_json"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("eligible_for_local_learning", "=", true).where("occurred_at", ">=", start)
    .orderBy("occurred_at").orderBy("id").limit(10000).execute() as LocalEventRow[];
}

export async function snapshotInputs(workspaceId: string, environmentId: string): Promise<{ environment: { kind: string; status: string } | null; worldNodes: Array<{ state: string; is_stale: boolean; node_type: string }>; drifts: Array<{ severity: string; state: string; category: string; action_class: string }> }> {
  if (!ids(environmentId)) return { environment: null, worldNodes: [], drifts: [] };
  const db = getDb();
  const [environment, worldNodes, drifts] = await Promise.all([
    db.selectFrom("workspace_environments").select(["kind", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst(),
    db.selectFrom("operational_world_nodes").select(["state", "is_stale", "node_type"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).execute(),
    db.selectFrom("operational_drift_items").select(["severity", "state", "category", "action_class"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
      .where("state", "in", ["open", "acknowledged", "planned"]).execute(),
  ]);
  return { environment: environment ?? null, worldNodes, drifts };
}

export async function insertSnapshot(row: Record<string, unknown>): Promise<any> {
  return guarded("Could not persist operational feature snapshot", () => getDb().insertInto("operational_feature_snapshots").values(json(row)).returningAll().executeTakeFirstOrThrow());
}

export async function persistModelVersion(workspaceId: string, modelId: string, rowFor: (version: number) => Record<string, unknown>, deploy: boolean, evaluationsFor: (versionId: string) => Array<Record<string, unknown>>): Promise<any> {
  return guarded("Could not persist model version", () => withTransaction(async (trx) => {
    const model = await trx.selectFrom("operational_model_registry").select("id").where("workspace_id", "=", workspaceId).where("id", "=", modelId).forUpdate().executeTakeFirst();
    if (!model) throw new Error("Could not persist model version");
    const latest = await trx.selectFrom("operational_model_versions").select(sql<number>`coalesce(max(version), 0)`.as("version")).where("model_id", "=", modelId).executeTakeFirstOrThrow();
    const created = await trx.insertInto("operational_model_versions").values(json(rowFor(Number(latest.version) + 1))).returningAll().executeTakeFirstOrThrow();
    if (deploy) {
      await trx.updateTable("operational_model_versions").set({ status: "retired" }).where("workspace_id", "=", workspaceId).where("model_id", "=", modelId).where("status", "=", "deployed").execute();
    }
    const updated = await trx.updateTable("operational_model_versions").set({ status: deploy ? "deployed" : "candidate", deployed_at: deploy ? new Date().toISOString() : null })
      .where("id", "=", created.id).returningAll().executeTakeFirstOrThrow();
    const evaluations = evaluationsFor(created.id);
    if (evaluations.length) await trx.insertInto("operational_model_evaluations").values(evaluations.map(json)).execute();
    return updated;
  }));
}

export async function deployedModelRows(workspaceId: string, family: string): Promise<{ model: any | null; version: any | null }> {
  const db = getDb();
  const model = await db.selectFrom("operational_model_registry").selectAll().where("workspace_id", "=", workspaceId).where("model_family", "=", family).where("enabled", "=", true).executeTakeFirst();
  if (!model) return { model: null, version: null };
  const version = await db.selectFrom("operational_model_versions").selectAll().where("workspace_id", "=", workspaceId).where("model_id", "=", model.id).where("status", "=", "deployed").executeTakeFirst();
  return { model, version: version ?? null };
}

export async function failDeployedVersion(workspaceId: string, versionId: string): Promise<void> {
  if (!ids(versionId)) return;
  await getDb().updateTable("operational_model_versions").set({ status: "failed" }).where("workspace_id", "=", workspaceId).where("id", "=", versionId).where("status", "=", "deployed").execute();
}

export async function insertPrediction(row: Record<string, unknown>): Promise<any> {
  return guarded("Could not persist operational prediction", () => getDb().insertInto("operational_predictions").values(json(row)).returningAll().executeTakeFirstOrThrow());
}

export async function planForPrediction(workspaceId: string, environmentId: string, planId: string): Promise<any | null> {
  if (!ids(environmentId, planId)) return null;
  return (await getDb().selectFrom("operational_change_plans")
    .select(["id", "deterministic_classification", "requires_approval", "immutable_plan_json", "plan_checksum_sha256", "source_discovery_run_id", "created_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", planId).executeTakeFirst()) ?? null;
}

export async function overviewRows(workspaceId: string, environmentId: string): Promise<{ modelVersions: any[]; predictions: any[]; featureSnapshots: any[]; evaluations: any[] }> {
  const db = getDb();
  const environmentOk = ids(environmentId);
  const [modelVersions, predictions, featureSnapshots, evaluations] = await Promise.all([
    db.selectFrom("operational_model_versions").selectAll().where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").limit(100).execute(),
    environmentOk ? db.selectFrom("operational_predictions").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("created_at", "desc").orderBy("id").limit(100).execute() : [],
    environmentOk
      ? db.selectFrom("operational_feature_snapshots").select(["id", "feature_family", "sample_support", "checksum_sha256", "captured_at", "expires_at", "provenance_json"])
        .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("captured_at", "desc").orderBy("id").limit(50).execute()
      : [],
    db.selectFrom("operational_model_evaluations").selectAll().where("workspace_id", "=", workspaceId).orderBy("evaluated_at", "desc").orderBy("id").limit(100).execute(),
  ]);
  return { modelVersions, predictions, featureSnapshots, evaluations };
}

export async function planPredictions(workspaceId: string, environmentId: string, planId: string): Promise<any[]> {
  if (!ids(environmentId)) return [];
  return getDb().selectFrom("operational_predictions")
    .select(["id", "prediction_key", "status", "probability", "estimate", "interval_lower", "interval_upper", "model_id", "model_version_id"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("subject_type", "=", "operational_change_plan").where("subject_id", "=", planId)
    .orderBy("created_at", "desc").orderBy("id").execute();
}

export async function upsertOutcomes(rows: Array<Record<string, unknown>>): Promise<void> {
  if (!rows.length) return;
  await guarded("Could not record prediction outcomes", () => withTransaction(async (trx) => {
    for (const row of rows) {
      await trx.insertInto("operational_prediction_outcomes").values(json(row))
        .onConflict((conflict) => conflict.column("prediction_id").doUpdateSet(excluded(row, ["prediction_id"])).where("operational_prediction_outcomes.workspace_id", "=", row.workspace_id as string))
        .execute();
    }
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
