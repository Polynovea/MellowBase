// PostgreSQL implementation of the data-aware change assessment reads and writes (phase 1, wave 4).
// Deliberate differences from the Supabase path it replaced in phase 1:
// - The target version is read through its model's workspace (the Supabase path read it by model
// id alone).
// - An assessment, its operational event and the audit event commit together.
// - Ties are broken by id; jsonb values are serialized explicitly; database text never reaches the
// caller.
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type TargetVersionRow = { id: string; version_number: number; schema_hash: string; schema_json: any };
export type SourceDeploymentRow = { id: string; schema_version: number; schema_hash: string; status: string; deployed_at: string; metadata_json: any };


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSESSMENT_JSON = ["provenance_json", "schema_diff_json", "data_profile_json", "hard_blockers_json", "warnings_json", "alternatives_json", "estimate_json"];
const EVENT_JSON = ["features_json", "outcome_json"];
const json = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, keys.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;

export async function assessmentSources(workspaceId: string, environmentId: string, modelId: string, targetHash: string): Promise<{ targetVersion: TargetVersionRow | null; sourceDeployment: SourceDeploymentRow | null }> {
  if (!UUID.test(environmentId) || !UUID.test(modelId)) return { targetVersion: null, sourceDeployment: null };
  const db = getDb();
  const [targetVersion, sourceDeployment] = await Promise.all([
    db.selectFrom("content_model_versions as v").innerJoin("content_models as m", "m.id", "v.content_model_id")
      .select(["v.id", "v.version_number", "v.schema_hash", "v.schema_json"])
      .where("m.workspace_id", "=", workspaceId).where("v.content_model_id", "=", modelId).where("v.schema_hash", "=", targetHash)
      .orderBy("v.version_number", "desc").limit(1).executeTakeFirst(),
    db.selectFrom("environment_schema_deployments").select(["id", "schema_version", "schema_hash", "status", "deployed_at", "metadata_json"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("content_model_id", "=", modelId).where("status", "in", ["deployed", "drifted"])
      .orderBy("deployed_at", "desc").orderBy("id").limit(1).executeTakeFirst(),
  ]);
  return { targetVersion: (targetVersion as TargetVersionRow | undefined) ?? null, sourceDeployment: (sourceDeployment as SourceDeploymentRow | undefined) ?? null };
}

export async function recordAssessment(row: Record<string, unknown>, event: Record<string, unknown>, auditFor: (assessment: any) => PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const persisted = await trx.insertInto("operational_change_assessments").values(json(row, ASSESSMENT_JSON)).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operational_events").values(json({ ...event, source_id: persisted.id }, EVENT_JSON)).execute();
      await recordPlatformEvent(trx, auditFor(persisted));
      return persisted;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not persist data-aware change assessment"));
  }
}

export async function listAssessments(workspaceId: string, environmentId: string, modelId?: string | null): Promise<any[]> {
  if (!UUID.test(environmentId) || (modelId && !UUID.test(modelId))) return [];
  let query = getDb().selectFrom("operational_change_assessments").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId);
  if (modelId) query = query.where("content_model_id", "=", modelId);
  return query.orderBy("created_at", "desc").orderBy("id").limit(50).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
