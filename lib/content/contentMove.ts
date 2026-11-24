// Moving existing content into the model tables (phase 3, wave 3).
//
// Per model:
//   1. ensureModelTable  the model's table must exist. If it does not, a schema change to the model's
//                        current version is queued through the migration runner (W2): the worker
//                        creates the table as polynovea_owner. This code never runs DDL.
//   2. backfillModel     the model's entries in id order (keyset paging), 1,000 per batch, one
//                        transaction per batch, each calling polynovea_content_sync_entries: the same
//                        function every save calls through the content_entries trigger.
//   3. verifyModel       polynovea_content_verify_model: row counts and a checksum of every field on
//                        both sides, recorded in content_model_move_runs.
//   4. setReadSource     reads move to the table only after a matching run; back to the snapshots at
//                        any time (the rollback).
//
// Everything here runs as polynovea_app: it calls the three SECURITY DEFINER functions (0076) and the
// runner's request API. Errors from those functions carry a code as their message.
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import type { DbExecutor } from "@/lib/db/index";
import { planStageStatus, requestSchemaChange } from "@/lib/schema/runner/request";
import type { SchemaLimits } from "@/lib/schema/engine/limits";

export const MOVE_BATCH_SIZE = 1000;

export type ReadSource = "snapshot" | "table";

export interface SyncResult {
  requested: number;
  synced: number;
  skipped_no_table: number;
  missing: number;
  failed: string[];
}

export interface BackfillResult {
  batches: number;
  entries: number;
  synced: number;
  skippedNoTable: number;
  missing: number;
  failed: string[];
  /** Batches run again after a deadlock or serialization failure (retryOnConflict). */
  retries: number;
  durationMs: number;
}

export interface VerifyResult {
  runId: string;
  matched: boolean;
  shapeHash: string;
  mismatches: Array<{ kind: string; column?: string; variant?: string }>;
}

export interface MoveRun {
  id: string;
  matched: boolean;
  shape_hash: string;
  counts: { snapshot: Record<string, number | string>; table: Record<string, number | string>; foreign_rows: number };
  fields: Record<string, { field: string; draft: { snapshot: [number, string] | null; table: [number, string] | null }; published: { snapshot: [number, string] | null; table: [number, string] | null } }>;
  mismatches: VerifyResult["mismatches"];
  backfill: Record<string, number>;
  started_at: string;
  finished_at: string;
}

/** SQLSTATEs worth running a batch again for: deadlock_detected, serialization_failure. */
const RETRYABLE_CODES = new Set(["40P01", "40001"]);

/**
 * Runs `run` again after a deadlock or a serialization failure: at most `retries` more times (3), with
 * exponential backoff and jitter (base 100 ms). Any other error, or the last one, is thrown.
 */
export async function retryOnConflict<T>(
  run: () => Promise<T>,
  options: { retries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, code: string) => void } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (attempt > retries || typeof code !== "string" || !RETRYABLE_CODES.has(code)) throw error;
      options.onRetry?.(attempt, code);
      await sleep((options.baseMs ?? 100) * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
}

/** Writes the table rows of up to 1,000 entries from their own current pointers (one transaction). */
export async function syncEntries(db: DbExecutor, entryIds: string[]): Promise<SyncResult> {
  const { rows: [row] } = await sql<{ result: SyncResult }>`select public.polynovea_content_sync_entries(${entryIds}::uuid[]) as result`.execute(db);
  return row.result;
}

export type EnsureTableResult =
  | { status: "exists"; table: string }
  | { status: "requested"; expandLedgerId: string | null }
  | { status: "no_schema_version" };

/**
 * The model's table, or a queued request for the migration worker to create it from the model's
 * current schema version.
 */
export async function ensureModelTable(
  db: DbExecutor,
  input: { workspaceId: string; modelId: string; requestedBy: string | null; limits?: SchemaLimits },
): Promise<EnsureTableResult> {
  const existing = await db.selectFrom("content_model_tables").select("table_name")
    .where("content_model_id", "=", input.modelId).where("workspace_id", "=", input.workspaceId).executeTakeFirst();
  if (existing) return { status: "exists", table: existing.table_name };
  const version = await db.selectFrom("content_model_versions as v")
    .innerJoin("content_models as m", (join) => join.onRef("m.id", "=", "v.content_model_id").onRef("m.current_schema_version", "=", "v.version_number"))
    .select("v.id").where("m.id", "=", input.modelId).where("m.workspace_id", "=", input.workspaceId)
    .executeTakeFirst();
  if (!version) return { status: "no_schema_version" };
  const { expandLedgerId } = await requestSchemaChange(db, {
    contentModelId: input.modelId, targetVersionId: version.id, requestedBy: input.requestedBy, limits: input.limits,
  });
  return { status: "requested", expandLedgerId };
}

/** Waits for a queued schema stage to finish (the worker runs it). */
export async function waitForStage(db: DbExecutor, ledgerId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const status = await planStageStatus(db, ledgerId);
    // Final states: a stage that failed, was superseded by a newer change or was cancelled will not run.
    if (status && ["succeeded", "failed", "superseded", "cancelled"].includes(status.status)) return status.status;
    if (Date.now() > deadline) return status?.status ?? "unknown";
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
  }
}

/**
 * Copies the current draft and published versions of every entry of the model into its table, in
 * batches of `batchSize` entries (keyset paging on the entry id, one transaction per batch).
 * Re-running it is safe: each entry's rows are rewritten from its current pointers.
 */
export async function backfillModel(
  db: Kysely<DB>,
  input: { workspaceId: string; modelId: string; batchSize?: number; onBatch?: (batch: number, result: SyncResult) => void },
): Promise<BackfillResult> {
  const started = Date.now();
  const size = Math.min(MOVE_BATCH_SIZE, Math.max(1, input.batchSize ?? MOVE_BATCH_SIZE));
  const total: BackfillResult = { batches: 0, entries: 0, synced: 0, skippedNoTable: 0, missing: 0, failed: [], retries: 0, durationMs: 0 };
  let cursor: string | null = null;
  for (;;) {
    const after = cursor;
    let query = db.selectFrom("content_entries").select("id")
      .where("workspace_id", "=", input.workspaceId).where("content_model_id", "=", input.modelId);
    if (after) query = query.where("id", ">", after);
    const ids = (await query.orderBy("id").limit(size).execute()).map((row) => row.id);
    if (!ids.length) break;
    // A batch that meets a save in a deadlock (or a serialization failure) is rolled back whole and
    // run again: each entry's rows are rewritten from its pointers, so a rerun is always safe.
    const result = await retryOnConflict(() => db.transaction().execute((trx) => syncEntries(trx, ids)), {
      onRetry: () => { total.retries += 1; },
    });
    total.batches += 1;
    total.entries += ids.length;
    total.synced += result.synced;
    total.skippedNoTable += result.skipped_no_table;
    total.missing += result.missing;
    total.failed.push(...result.failed);
    input.onBatch?.(total.batches, result);
    cursor = ids[ids.length - 1];
    if (ids.length < size) break;
  }
  total.durationMs = Date.now() - started;
  return total;
}

/** Compares the model's table with its snapshots and records the run. */
export async function verifyModel(
  db: DbExecutor,
  input: { workspaceId: string; modelId: string; requestedBy?: string | null; backfill?: Pick<BackfillResult, "batches" | "entries" | "failed"> },
): Promise<VerifyResult> {
  const b = input.backfill;
  const { rows: [row] } = await sql<{ result: { run_id: string; matched: boolean; shape_hash: string; mismatches: VerifyResult["mismatches"] } }>`
    select public.polynovea_content_verify_model(
      ${input.workspaceId}::uuid, ${input.modelId}::uuid, ${input.requestedBy ?? null}::uuid,
      ${b ? b.batches : null}::integer, ${b ? b.entries : null}::integer, ${b ? b.failed.length : null}::integer) as result`.execute(db);
  return { runId: row.result.run_id, matched: row.result.matched, shapeHash: row.result.shape_hash, mismatches: row.result.mismatches };
}

/** A recorded run, with every count and checksum. */
export async function moveRun(db: DbExecutor, runId: string): Promise<MoveRun | null> {
  const row = await db.selectFrom("content_model_move_runs")
    .select(["id", "matched", "shape_hash", "counts", "fields", "mismatches", "backfill", "started_at", "finished_at"])
    .where("id", "=", runId).executeTakeFirst();
  return (row as unknown as MoveRun) ?? null;
}

/**
 * Switches the model's current-content reads. 'table' needs a matching run on the table's current
 * shape (the database checks it under lock); 'snapshot' always works and is the rollback.
 */
export async function setReadSource(db: DbExecutor, input: { workspaceId: string; modelId: string; source: ReadSource; actor?: string | null }): Promise<void> {
  await sql`select public.polynovea_content_set_read_source(${input.workspaceId}::uuid, ${input.modelId}::uuid, ${input.source}, ${input.actor ?? null}::uuid)`.execute(db);
}

export async function readSourceOf(db: DbExecutor, modelId: string): Promise<ReadSource> {
  const row = await db.selectFrom("content_model_storage").select("read_source").where("content_model_id", "=", modelId).executeTakeFirst();
  return row?.read_source === "table" ? "table" : "snapshot";
}

export interface MoveModelResult {
  modelId: string;
  table: EnsureTableResult;
  backfill?: BackfillResult;
  verify?: VerifyResult;
  switched: boolean;
}

/** Backfill, verify and (with switchReads) switch one model whose table exists. */
export async function moveModel(
  db: Kysely<DB>,
  input: { workspaceId: string; modelId: string; requestedBy?: string | null; switchReads?: boolean; batchSize?: number },
): Promise<MoveModelResult> {
  const table = await ensureModelTable(db, { workspaceId: input.workspaceId, modelId: input.modelId, requestedBy: input.requestedBy ?? null });
  if (table.status !== "exists") return { modelId: input.modelId, table, switched: false };
  const backfill = await backfillModel(db, { workspaceId: input.workspaceId, modelId: input.modelId, batchSize: input.batchSize });
  const verify = await verifyModel(db, { workspaceId: input.workspaceId, modelId: input.modelId, requestedBy: input.requestedBy, backfill });
  let switched = false;
  if (input.switchReads && verify.matched) {
    await setReadSource(db, { workspaceId: input.workspaceId, modelId: input.modelId, source: "table", actor: input.requestedBy });
    switched = true;
  }
  return { modelId: input.modelId, table, backfill, verify, switched };
}

/**
 * Models already moved (they have a run) whose table no longer matches their latest run: a schema stage
 * or a contract changed the table's shape, or a save failed to reach the table since that run (at once);
 * or whose latest run did not match (again only after a pause that doubles with each unmatched run in a
 * row: 1 minute, 2, 4 ... at most 1 hour, so a broken model is not re-synced on every pass). Models with
 * a schema stage queued or running are left until it finishes. Oldest first.
 */
export async function modelsNeedingResync(db: DbExecutor, options: { modelId?: string; limit?: number } = {}): Promise<Array<{ modelId: string; workspaceId: string; readSource: ReadSource }>> {
  const { rows } = await sql<{ content_model_id: string; workspace_id: string; read_source: string }>`
    select s.content_model_id, s.workspace_id, s.read_source
      from public.content_model_storage s
      join public.content_model_tables t on t.content_model_id = s.content_model_id and t.workspace_id = s.workspace_id
      left join public.content_model_move_runs r on r.id = s.last_run_id
      left join lateral (
        select count(*)::int as n from public.content_model_move_runs f
         where f.content_model_id = s.content_model_id and not f.matched
           and f.started_at > coalesce((select max(g.started_at) from public.content_model_move_runs g
                                         where g.content_model_id = s.content_model_id and g.matched), '-infinity'::timestamptz)
      ) unmatched on not r.matched
     where s.last_run_id is not null
       and (r.id is null or r.shape_hash <> t.applied_shape_hash or s.sync_failures <> r.sync_failures
            or (not r.matched and r.finished_at <= now() - least(interval '1 hour', interval '1 minute' * power(2, greatest(unmatched.n, 1) - 1))))
       and not exists (select 1 from public.schema_migration_ledger l where l.content_model_id = s.content_model_id and l.status in ('pending', 'running'))
       ${options.modelId ? sql`and s.content_model_id = ${options.modelId}::uuid` : sql``}
     order by s.updated_at, s.content_model_id
     limit ${Math.min(100, Math.max(1, options.limit ?? 20))}`.execute(db);
  return rows.map((row) => ({ modelId: row.content_model_id, workspaceId: row.workspace_id, readSource: row.read_source === "table" ? "table" : "snapshot" }));
}

type ResyncLog = (event: string, fields: Record<string, unknown>) => void;

/** A code for a log line: a SQLSTATE and/or the function's own code message, never text or values. */
function resyncErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  const message = (error as { message?: unknown })?.message;
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "error";
  return typeof message === "string" && /^[a-z0-9_]{1,64}$/.test(message) ? `${sqlstate}:${message}` : sqlstate;
}

/**
 * Models whose verification itself failed (nothing could be recorded), by id: skipped until `until`,
 * with the same doubling pause as unmatched runs. In the worker's memory only; a recorded run is the
 * durable back-off (modelsNeedingResync).
 */
const verifyBackoff = new Map<string, { failures: number; until: number }>();
const pauseMs = (failures: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));

/**
 * Run by the migration worker (owner side) after each pass: re-syncs (1,000-entry batches) and
 * re-verifies every model from modelsNeedingResync. A model whose intent is 'table' reads from its table
 * again as soon as the new run matches the table's current shape (tableStore requires exactly that);
 * a run that does not match keeps its reads on the snapshots and is recorded in content_model_move_runs
 * with its mismatches. A re-sync that fails part-way is still verified, so the failure is a recorded
 * run (the table as it is, against the snapshots) and the model waits out its pause before the next
 * try. Logs ids, counts and codes only. Returns how many models it re-synced.
 */
export async function resyncChangedModels(db: Kysely<DB>, options: { modelId?: string; log?: ResyncLog; now?: () => number } = {}): Promise<number> {
  const log: ResyncLog = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  let done = 0;
  for (const model of await modelsNeedingResync(db, { modelId: options.modelId })) {
    const paused = verifyBackoff.get(model.modelId);
    if (paused && paused.until > now()) continue;
    let backfill: BackfillResult | undefined;
    let backfillCode: string | null = null;
    try {
      backfill = await backfillModel(db, { workspaceId: model.workspaceId, modelId: model.modelId });
    } catch (error) {
      backfillCode = resyncErrorCode(error);
    }
    try {
      const verify = await verifyModel(db, { workspaceId: model.workspaceId, modelId: model.modelId, backfill });
      verifyBackoff.delete(model.modelId);
      done += 1;
      log(backfillCode ? "content_resync_failed" : "content_resynced", {
        modelId: model.modelId, runId: verify.runId, matched: verify.matched,
        ...(backfillCode ? { code: backfillCode } : {}),
        batches: backfill?.batches, entries: backfill?.entries, failedEntries: backfill?.failed.length, retries: backfill?.retries,
        mismatches: verify.mismatches.map((m) => m.kind),
        reads: model.readSource === "table" && verify.matched ? "table" : "snapshot",
      });
    } catch (error) {
      const failures = (paused?.failures ?? 0) + 1;
      verifyBackoff.set(model.modelId, { failures, until: now() + pauseMs(failures) });
      log("content_resync_failed", { modelId: model.modelId, code: backfillCode ?? resyncErrorCode(error), verifyCode: resyncErrorCode(error), pauseMs: pauseMs(failures) });
    }
  }
  return done;
}
