// Direct PostgreSQL implementation of the migration strategy run and batch reads and writes
// (phase 1, wave 4). Same signatures and shapes as migrationRunData.supabase.ts. Differences that
// are deliberate:
// - Run and batch updates are scoped by workspace_id as well as id.
// - Completing a run and its audit event commit together.
// - Entry versions are read through the entry's workspace (content_entry_versions has no
//   workspace_id).
// - Ties are broken by id; jsonb values are serialized explicitly; database text never reaches the
//   caller.
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { EntryBatchRow } from "@/lib/intelligence/migrationRunData.supabase";

export type { EntryBatchRow } from "@/lib/intelligence/migrationRunData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_JSON = ["cursor_json", "input_descriptor_json", "plan_json", "postcondition_json", "progress_json", "provenance_json"];
const BATCH_JSON = ["cursor_after_json", "cursor_before_json", "error_json", "safe_results_json"];
const json = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, keys.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;

export async function reusableRun(workspaceId: string, environmentId: string, assessmentId: string, strategyKey: string, inputHash: string): Promise<any | null> {
  if (!UUID.test(environmentId) || !UUID.test(assessmentId)) return null;
  return (await getDb().selectFrom("operational_migration_runs").selectAll()
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("assessment_id", "=", assessmentId)
    .where("strategy_key", "=", strategyKey).where("input_hash_sha256", "=", inputHash)
    .where("status", "in", ["planned", "running", "paused", "blocked", "succeeded"])
    .orderBy("created_at", "desc").orderBy("id").limit(1).executeTakeFirst()) ?? null;
}

export async function insertRun(row: Record<string, unknown>): Promise<any> {
  try {
    return await getDb().insertInto("operational_migration_runs").values(json(row, RUN_JSON)).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not create migration strategy run"));
  }
}

export async function updateRun(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<any | null> {
  try {
    return (await getDb().updateTable("operational_migration_runs").set(json(patch, RUN_JSON)).where("workspace_id", "=", workspaceId).where("id", "=", runId).returningAll().executeTakeFirst()) ?? null;
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not update migration run"));
  }
}

export async function completeRun(workspaceId: string, runId: string, patch: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const completed = await trx.updateTable("operational_migration_runs").set(json(patch, RUN_JSON)).where("workspace_id", "=", workspaceId).where("id", "=", runId).returningAll().executeTakeFirst();
      if (!completed) throw new Error("Could not finalize migration run");
      await recordPlatformEvent(trx, audit);
      return completed;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not finalize migration run"));
  }
}

export async function entryBatch(workspaceId: string, modelId: string, cursorId: string | null, batchSize: number): Promise<EntryBatchRow[]> {
  if (!UUID.test(modelId) || (cursorId && !UUID.test(cursorId))) return [];
  const db = getDb();
  let query = db.selectFrom("content_entries").select(["id", "current_draft_version_id", "published_version_id"])
    .where("workspace_id", "=", workspaceId).where("content_model_id", "=", modelId).where("archived_at", "is", null);
  if (cursorId) query = query.where("id", ">", cursorId);
  const entries = await query.orderBy("id").limit(batchSize).execute();
  const versionIds = entries.map((entry) => entry.current_draft_version_id ?? entry.published_version_id).filter((id): id is string => Boolean(id));
  const versions = versionIds.length
    ? await db.selectFrom("content_entry_versions as v").innerJoin("content_entries as e", "e.id", "v.entry_id")
      .select(["v.id", "v.entry_id", "v.version_number", "v.locale", "v.data_jsonb"]).where("e.workspace_id", "=", workspaceId).where("v.id", "in", versionIds).execute()
    : [];
  const versionById = new Map(versions.map((version) => [version.id, version]));
  return entries.map((entry) => ({ entry, version: (versionById.get((entry.current_draft_version_id ?? entry.published_version_id) as string) as EntryBatchRow["version"]) ?? null }));
}

export async function startBatch(row: Record<string, unknown>): Promise<any> {
  try {
    return await getDb().insertInto("operational_migration_batches").values(json(row, BATCH_JSON)).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not start migration batch"));
  }
}

export async function finishBatch(workspaceId: string, batchId: string, patch: Record<string, unknown>): Promise<void> {
  await getDb().updateTable("operational_migration_batches").set(json(patch, BATCH_JSON)).where("workspace_id", "=", workspaceId).where("id", "=", batchId).execute();
}

export async function listRuns(workspaceId: string, environmentId: string, modelId?: string | null): Promise<any[]> {
  if (!UUID.test(environmentId) || (modelId && !UUID.test(modelId))) return [];
  let query = getDb().selectFrom("operational_migration_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId);
  if (modelId) query = query.where("content_model_id", "=", modelId);
  return query.orderBy("created_at", "desc").orderBy("id").limit(100).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
