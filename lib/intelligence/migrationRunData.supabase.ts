// Supabase path of the migration strategy run and batch reads and writes (queries moved unchanged
// from migrationStrategyService.ts; deleted with the switch at the end of phase 1). Strategy
// validation, transforms, batching rules and the deploy step stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type EntryBatchRow = {
  entry: { id: string; current_draft_version_id: string | null; published_version_id: string | null };
  version: { id: string; entry_id: string; version_number: number; locale: string; data_jsonb: any } | null;
};

/** The newest run of this assessment, strategy and input that can be resumed or is already done. */
export async function reusableRun(workspaceId: string, environmentId: string, assessmentId: string, strategyKey: string, inputHash: string): Promise<any | null> {
  const { data: existing } = await createServiceRoleClient().from("operational_migration_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("environment_id", environmentId)
    .eq("assessment_id", assessmentId)
    .eq("strategy_key", strategyKey)
    .eq("input_hash_sha256", inputHash)
    .in("status", ["planned", "running", "paused", "blocked", "succeeded"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return existing ?? null;
}

export async function insertRun(row: Record<string, unknown>): Promise<any> {
  const { data: run, error } = await createServiceRoleClient().from("operational_migration_runs").insert(row).select().single();
  if (error || !run) throw new Error(error?.message || "Could not create migration strategy run");
  return run;
}

/** Updates a run of the workspace; null when the update did not return it. */
export async function updateRun(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<any | null> {
  void workspaceId; // the caller read or created the run in the workspace
  // maybeSingle: a missing run is null for the caller's own message, not PostgREST's single-row error.
  const { data, error } = await createServiceRoleClient().from("operational_migration_runs").update(patch).eq("id", runId).select().maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

/** Marks a run succeeded and writes the audit event. */
export async function completeRun(workspaceId: string, runId: string, patch: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  void workspaceId; // the caller read or created the run in the workspace
  const { data: completed, error } = await createServiceRoleClient().from("operational_migration_runs").update(patch).eq("id", runId).select().single();
  if (error || !completed) throw new Error(error?.message || "Could not finalize migration run");
  await logPlatformEvent(audit);
  return completed;
}

/** The next batch of the model's live entries after the cursor, each with its current version. */
export async function entryBatch(workspaceId: string, modelId: string, cursorId: string | null, batchSize: number): Promise<EntryBatchRow[]> {
  const db = createServiceRoleClient();
  let query = db.from("content_entries")
    .select("id,current_draft_version_id,published_version_id")
    .eq("workspace_id", workspaceId)
    .eq("content_model_id", modelId)
    .is("archived_at", null)
    .order("id", { ascending: true })
    .limit(batchSize);
  if (cursorId) query = query.gt("id", cursorId);
  const { data: entries, error } = await query;
  if (error) throw new Error(error.message);
  const versionIds = (entries ?? []).map((entry) => entry.current_draft_version_id ?? entry.published_version_id).filter(Boolean);
  const { data: versions, error: versionError } = versionIds.length
    ? await db.from("content_entry_versions").select("id,entry_id,version_number,locale,data_jsonb").in("id", versionIds)
    : { data: [], error: null };
  if (versionError) throw new Error(versionError.message);
  const versionById = new Map((versions ?? []).map((version: any) => [version.id, version]));
  return (entries ?? []).map((entry) => ({ entry, version: versionById.get(entry.current_draft_version_id ?? entry.published_version_id) ?? null }));
}

export async function startBatch(row: Record<string, unknown>): Promise<any> {
  const { data: batch, error } = await createServiceRoleClient().from("operational_migration_batches").insert(row).select().single();
  if (error || !batch) throw new Error(error?.message || "Could not start migration batch");
  return batch;
}

export async function finishBatch(workspaceId: string, batchId: string, patch: Record<string, unknown>): Promise<void> {
  void workspaceId; // the caller started the batch in the workspace
  await createServiceRoleClient().from("operational_migration_batches").update(patch).eq("id", batchId);
}

export async function listRuns(workspaceId: string, environmentId: string, modelId?: string | null): Promise<any[]> {
  let query = createServiceRoleClient().from("operational_migration_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId);
  if (modelId) query = query.eq("content_model_id", modelId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
