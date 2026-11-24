// The worker's side of the migration ledger: claiming a stage, its run row (progress and per-step
// timings, schema_migration_runs) and recording the outcome. Owner connection only.
//
// Claiming. The runner takes a session advisory lock per model with the two-key form
// pg_try_advisory_lock(RUNNER_LOCK_CLASS, <int from the model id>), so it cannot collide with any
// other advisory lock in the CMS (which uses the one-key form or other classes). The lock is held on
// the worker's pinned session for the whole run and is the lease: if the worker dies, PostgreSQL
// drops the lock with the session, and the next worker that sees the row still "running" takes the
// lock and resumes it from its run row. Stages of one model run strictly oldest first.
import type pg from "pg";
import { RefusedError } from "@/lib/schema/runner/errors";
import type { LedgerRow } from "@/lib/schema/runner/verify";

/**
 * The advisory lock class of the schema migration runner: 0x504D5233, "PMR3" in ASCII
 * (Polynovea Migration Runner, phase 3). Reserved for this purpose; never reuse it.
 */
export const RUNNER_LOCK_CLASS = 0x504d5233;

/** The second key: the first 32 bits of the uuid, as a signed int4. */
export function lockKey(uuid: string): number {
  const hex = uuid.replace(/-/g, "").slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(hex)) throw new RefusedError("ledger_malformed");
  return Number.parseInt(hex, 16) | 0;
}

export async function tryLockModel(client: pg.ClientBase, modelId: string): Promise<boolean> {
  const { rows: [row] } = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1, $2) as locked", [RUNNER_LOCK_CLASS, lockKey(modelId)]);
  return Boolean(row?.locked);
}

export async function unlockModel(client: pg.ClientBase, modelId: string): Promise<void> {
  await client.query("select pg_advisory_unlock($1, $2)", [RUNNER_LOCK_CLASS, lockKey(modelId)]);
}

const LEDGER_COLUMNS = `id, workspace_id, content_model_id, model_api_key, table_name, stage, status, plan_hash,
  base_shape_hash, target_schema_hash, plan_json, target_version_id, renames, requested_by, confirmed_by, confirmed_at, attempts, created_at`;

export interface ClaimedStage {
  row: LedgerRow;
  modelId: string;
}

/**
 * Claims the oldest runnable stage: pending, or running with no live worker (its model lock is free),
 * optionally only of one model.
 * Returns null when there is none. On success the model's advisory lock is held on `client`; the
 * caller must call unlockModel when done.
 */
export async function claimNextStage(client: pg.ClientBase, filter: { modelId?: string } = {}): Promise<ClaimedStage | null> {
  const { rows: candidates } = await client.query<{ id: string; content_model_id: string }>(
    `select l.id, l.content_model_id
       from public.schema_migration_ledger l
      where l.status in ('pending', 'running') and l.content_model_id is not null
        and ($1::uuid is null or l.content_model_id = $1)
        and not exists (
          select 1 from public.schema_migration_ledger o
           where o.content_model_id = l.content_model_id and o.status in ('pending', 'running')
             and (o.created_at, o.id) < (l.created_at, l.id))
      order by l.created_at, l.id
      limit 20`,
    [filter.modelId ?? null],
  );
  for (const candidate of candidates) {
    if (!(await tryLockModel(client, candidate.content_model_id))) continue;
    const { rows: [row] } = await client.query<LedgerRow>(
      `update public.schema_migration_ledger
          set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()), finished_at = null, error_ref = null
        where id = $1 and status in ('pending', 'running') and content_model_id = $2
        returning ${LEDGER_COLUMNS}`,
      [candidate.id, candidate.content_model_id],
    );
    if (row) return { row, modelId: candidate.content_model_id };
    await unlockModel(client, candidate.content_model_id);
  }
  return null;
}

export interface RunRow {
  id: string;
  status: "running" | "succeeded" | "failed" | "refused";
  next_step: number;
  next_statement: number;
  /** True when an earlier attempt of this stage already ran (this one resumes it). */
  resumed: boolean;
}

/** The run row of a ledger stage: created on the first attempt, taken over on later ones. */
export async function openRun(client: pg.ClientBase, row: LedgerRow, workerId: string): Promise<RunRow> {
  const { rows: [run] } = await client.query<RunRow>(
    `insert into public.schema_migration_runs (ledger_id, workspace_id, content_model_id, stage, status, worker_id)
     values ($1, $2, $3, $4, 'running', $5)
     on conflict (ledger_id) do update
        set status = 'running', worker_id = excluded.worker_id, error_ref = null, finished_at = null, updated_at = now()
     returning id, status, next_step, next_statement, (xmax <> 0) as resumed`,
    [row.id, row.workspace_id, row.content_model_id, row.stage, workerId],
  );
  return run;
}

/** Moves the run's position; used inside the transaction of the statements it covers. */
export async function setProgress(client: pg.ClientBase, runId: string, nextStep: number, nextStatement: number, lockRetries = 0): Promise<void> {
  await client.query(
    `update public.schema_migration_runs
        set next_step = $2, next_statement = $3, lock_retries = lock_retries + $4, updated_at = now()
      where id = $1`,
    [runId, nextStep, nextStatement, lockRetries],
  );
}

export interface StepLogEntry {
  step: number;
  planIndex: number;
  kind: string;
  startedAt: string;
  finishedAt: string;
  statements: number;
  lockRetries: number;
}

/** Marks a step done: the position moves to the next step and its timings are appended to the log. */
export async function finishStep(client: pg.ClientBase, runId: string, entry: StepLogEntry): Promise<void> {
  await client.query(
    `update public.schema_migration_runs
        set next_step = $2, next_statement = 0, step_log = step_log || jsonb_build_array($3::jsonb),
            lock_retries = lock_retries + $4, updated_at = now()
      where id = $1`,
    [runId, entry.step + 1, JSON.stringify(entry), entry.lockRetries],
  );
}

/**
 * A model may not start a new stage while an earlier one stopped halfway: a failed run that got past
 * its first statement, or an expand/contract task still expanding or failed (its dual-write trigger
 * and new column are on the table even when the run itself is at 0/0). Retrying that stage, or
 * rolling its task back (rollbackExpandTask), clears it.
 */
export async function unfinishedStageOf(client: pg.ClientBase, modelId: string, exceptLedgerId: string): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 from public.schema_migration_runs r
       join public.schema_migration_ledger l on l.id = r.ledger_id
      where r.content_model_id = $1 and r.ledger_id <> $2 and r.status = 'failed'
        and (r.next_step > 0 or r.next_statement > 0) and l.status <> 'succeeded'
     union all
     select 1 from public.schema_expand_contract_tasks t
      where t.content_model_id = $1 and t.ledger_id <> $2 and t.status in ('expanding', 'failed')
      limit 1`,
    [modelId, exceptLedgerId],
  );
  return rows.length > 0;
}

export async function markSucceeded(client: pg.ClientBase, ledgerId: string, runId: string): Promise<void> {
  await client.query("update public.schema_migration_runs set status = 'succeeded', finished_at = now(), updated_at = now() where id = $1", [runId]);
  await client.query("update public.schema_migration_ledger set status = 'succeeded', finished_at = now(), error_ref = null where id = $1", [ledgerId]);
}

/** Failed (something ran, or tried to) or refused (nothing ran). `code` is an error code, never text. */
export async function markFailed(client: pg.ClientBase, row: LedgerRow, workerId: string, code: string, refused: boolean): Promise<void> {
  // The ledger row always gets the outcome; the run row is best effort (a malformed row may not fit it).
  await client.query(
    `insert into public.schema_migration_runs (ledger_id, workspace_id, content_model_id, stage, status, worker_id, error_ref, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (ledger_id) do update
        set status = excluded.status, worker_id = excluded.worker_id, error_ref = excluded.error_ref, finished_at = now(), updated_at = now()`,
    [row.id, row.workspace_id, row.content_model_id, row.stage === "destructive" ? "destructive" : "expand", refused ? "refused" : "failed", workerId, code],
  ).catch(() => undefined);
  await client.query("update public.schema_migration_ledger set status = 'failed', finished_at = now(), error_ref = $2 where id = $1", [row.id, code]);
}
