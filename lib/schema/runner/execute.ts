// Runs one plan step's statements, as rendered by the engine, the way each must run.
//
// - Consecutive transactional statements with the same lockSensitive flag share one short
//   transaction. A NOT VALID constraint (lock-sensitive, instant) and its VALIDATE (a long scan that
//   lets reads and writes continue) therefore never share one: the brief exclusive lock is released
//   before the scan starts.
// - Each transaction sets lock_timeout to 3 seconds and is retried with backoff after a lock conflict
//   (lockRetry.ts); it is never held open across a sleep.
// - The run's position (schema_migration_runs.next_statement) moves in the same transaction as the
//   statements it covers, so a run that crashes is resumed exactly after the last committed statement.
// - Non-transactional statements (CREATE / DROP INDEX CONCURRENTLY) run alone on the session, outside
//   any transaction, with the patient lock wait of lockRetry.ts (they wait for every older transaction
//   in the database but never block reads or writes), then the session goes back to 3 seconds. A failed concurrent build leaves an INVALID index behind; the runner drops every
//   invalid index on the model's table before such a statement and after it fails, then retries. When a
//   resumed run repeats one that had in fact finished, "already exists" / "does not exist" count as done.
import type pg from "pg";
import { sql } from "kysely";
import type { PlanStep, RenderedStatement } from "@/lib/schema/engine/plan";
import { compile, type SchemaEngine } from "@/lib/schema/runner/engine";
import { RunnerError, sqlState } from "@/lib/schema/runner/errors";
import { concurrentLockTimeoutMs, LOCK_TIMEOUT_MS, withLockRetry, type LockRetryOptions } from "@/lib/schema/runner/lockRetry";
import { setProgress } from "@/lib/schema/runner/ledger";

/** A structured log line: an event name and codes, ids or numbers only (never SQL, names or values). */
export type RunnerLog = (event: string, fields: Record<string, string | number | boolean | null>) => void;

/** Test hooks: throwing from one simulates a crash at that point. */
export interface RunnerHooks {
  /** Inside a statement group's transaction, after its statements and progress, before COMMIT. */
  beforeCommit?(point: { step: number; statement: number }): void | Promise<void>;
  /** After a non-transactional statement ran, before its progress is recorded. */
  afterNonTransactional?(point: { step: number; statement: number }): void | Promise<void>;
  /** After a backfill batch committed (expand and contract). */
  afterBackfillBatch?(point: { step: number; batch: number; rows: number }): void | Promise<void>;
}

export interface StepContext {
  client: pg.ClientBase;
  engine: SchemaEngine;
  runId: string;
  /** The model's table (content.<table>). */
  table: string;
  retry?: LockRetryOptions;
  hooks?: RunnerHooks;
  /** Lock wait for CONCURRENTLY statements; default concurrentLockTimeoutMs(), capped below the session's statement_timeout. */
  concurrentLockTimeoutMs?: number;
  log?: RunnerLog;
  /** A second connection (the owner pool) to look at a long CONCURRENTLY statement from outside. */
  observer?: Pick<pg.ClientBase, "query">;
  /** How often a long CONCURRENTLY statement is reported (default 10 s). */
  waitLogIntervalMs?: number;
}

const PHASE_CODE = /[^a-z0-9]+/g;

/**
 * While a CONCURRENTLY statement runs, reports it every interval so an operator can see why an index
 * stage is slow: "waiting_for_older_transactions" when it waits (a lock wait, or a progress phase
 * "waiting for ..."), with the elapsed time and the phase as a code. Returns a stop function.
 */
function watchConcurrent(ctx: StepContext, backendPid: number | null): () => void {
  const log = ctx.log;
  if (!log) return () => undefined;
  const started = Date.now();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let event = "concurrent_statement_running";
      let phase: string | null = null;
      if (ctx.observer && backendPid !== null) {
        const { rows: [row] } = await ctx.observer.query(
          `select a.wait_event_type, p.phase from pg_catalog.pg_stat_activity a
             left join pg_catalog.pg_stat_progress_create_index p on p.pid = a.pid
            where a.pid = $1`,
          [backendPid],
        );
        phase = typeof row?.phase === "string" ? row.phase.toLowerCase().replace(PHASE_CODE, "_").slice(0, 60) : null;
        if (row?.wait_event_type === "Lock" || phase?.startsWith("waiting")) event = "waiting_for_older_transactions";
      }
      log(event, { elapsedMs: Date.now() - started, phase });
    } catch {
      // Observation only: never affects the statement.
    } finally {
      busy = false;
    }
  }, ctx.waitLogIntervalMs ?? 10_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    const elapsedMs = Date.now() - started;
    if (elapsedMs >= (ctx.waitLogIntervalMs ?? 10_000)) log("concurrent_statement_done", { elapsedMs });
  };
}

/** The patient lock wait for CONCURRENTLY statements, capped a minute below the session's statement_timeout. */
async function patientLockTimeout(ctx: StepContext): Promise<number> {
  const wanted = Math.floor(ctx.concurrentLockTimeoutMs ?? concurrentLockTimeoutMs());
  const { rows: [row] } = await ctx.client.query<{ ms: string | number }>(
    "select (extract(epoch from current_setting('statement_timeout')::interval) * 1000)::bigint as ms",
  );
  const statementTimeout = Number(row?.ms ?? 0);
  const cap = statementTimeout > 0 ? statementTimeout - 60_000 : Number.POSITIVE_INFINITY;
  return Math.max(LOCK_TIMEOUT_MS, Math.min(wanted, cap));
}

export interface StatementGroup {
  start: number;
  end: number;
  transactional: boolean;
}

/** Splits a step's statements into the units that commit together. */
export function groupStatements(statements: readonly RenderedStatement[]): StatementGroup[] {
  const groups: StatementGroup[] = [];
  statements.forEach((statement, index) => {
    const last = groups.at(-1);
    const previous = statements[index - 1];
    if (
      statement.transactional && last?.transactional && previous?.transactional
      && previous.lockSensitive === statement.lockSensitive && last.end === index
    ) {
      last.end = index + 1;
    } else {
      groups.push({ start: index, end: index + 1, transactional: statement.transactional });
    }
  });
  return groups;
}

async function rollback(client: pg.ClientBase) {
  await client.query("rollback").catch(() => undefined);
}

/**
 * Runs `work` in one transaction with a 3-second lock timeout, retrying the whole transaction after a
 * lock conflict. Returns the work's value and how many retries it took.
 */
export async function inLockTimedTransaction<T>(client: pg.ClientBase, work: () => Promise<T>, retry?: LockRetryOptions): Promise<{ value: T; retries: number }> {
  return withLockRetry(async () => {
    await client.query("begin");
    try {
      await client.query(`set local lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      const value = await work();
      await client.query("commit");
      return value;
    } catch (error) {
      await rollback(client);
      throw error;
    }
  }, retry);
}

/** Drops every INVALID index on content.<table>: what a failed CREATE INDEX CONCURRENTLY leaves. */
export async function dropInvalidIndexes(client: pg.ClientBase, table: string, retry?: LockRetryOptions): Promise<number> {
  const { rows } = await client.query<{ name: string }>(
    `select ic.relname as name
       from pg_catalog.pg_index i
       join pg_catalog.pg_class ic on ic.oid = i.indexrelid
       join pg_catalog.pg_class tc on tc.oid = i.indrelid
       join pg_catalog.pg_namespace n on n.oid = tc.relnamespace
      where n.nspname = 'content' and tc.relname = $1 and not i.indisvalid`,
    [table],
  );
  for (const { name } of rows) {
    const statement = compile(sql`drop index concurrently if exists ${sql.id("content", name)}`);
    await withLockRetry(() => client.query(statement.text, statement.values), retry);
  }
  return rows.length;
}

async function runNonTransactional(ctx: StepContext, statement: RenderedStatement, resumedHere: boolean): Promise<number> {
  const { client, table, retry } = ctx;
  const compiled = compile(statement.sql);
  const patient = await patientLockTimeout(ctx);
  await client.query(`set lock_timeout = '${patient}ms'`);
  const { rows: [me] } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  try {
    await dropInvalidIndexes(client, table, retry);
    const { retries } = await withLockRetry(async () => {
      const stopWatch = watchConcurrent(ctx, me?.pid ?? null);
      try {
        await client.query(compiled.text, compiled.values);
        stopWatch();
      } catch (error) {
        stopWatch();
        const state = sqlState(error);
        // A resumed run repeating a statement that had finished before the crash.
        if (resumedHere && (state === "42P07" || state === "42704")) return;
        await dropInvalidIndexes(client, table, retry).catch(() => undefined);
        throw error;
      }
    }, retry);
    return retries;
  } finally {
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT_MS}ms'`).catch(() => undefined);
  }
}

export interface StepResult {
  statements: number;
  lockRetries: number;
}

/** Records that statements before `nextStatement` are done; runs inside their transaction when they have one. */
export type ProgressWriter = (nextStatement: number) => Promise<void>;

/**
 * Runs `statements` from `startStatement`, grouped and timed as described at the top of this file.
 * `progress` records the position (inside each group's transaction). `resumed` is true when an
 * earlier attempt may have run the statement at `startStatement`.
 */
export async function executeStatements(
  ctx: StepContext,
  statements: readonly RenderedStatement[],
  startStatement: number,
  resumed: boolean,
  progress: ProgressWriter,
  hookStep: number,
): Promise<StepResult> {
  const groups = groupStatements(statements);
  if (startStatement > statements.length || (startStatement < statements.length && !groups.some((group) => group.start === startStatement))) {
    throw new RunnerError("progress_mismatch");
  }
  let lockRetries = 0;
  for (const group of groups.filter((candidate) => candidate.start >= startStatement)) {
    if (group.transactional) {
      const { retries } = await inLockTimedTransaction(ctx.client, async () => {
        for (const statement of statements.slice(group.start, group.end)) {
          const compiled = compile(statement.sql);
          await ctx.client.query(compiled.text, compiled.values);
        }
        await progress(group.end);
        await ctx.hooks?.beforeCommit?.({ step: hookStep, statement: group.start });
      }, ctx.retry);
      lockRetries += retries;
    } else {
      lockRetries += await runNonTransactional(ctx, statements[group.start], resumed && group.start === startStatement);
      await ctx.hooks?.afterNonTransactional?.({ step: hookStep, statement: group.start });
      await progress(group.end);
    }
  }
  return { statements: statements.length, lockRetries };
}

/**
 * Runs the statements of one regular step (everything but expand and contract) from `startStatement`.
 * `stepIndex` is the step's position in the stage; the run row's position moves with each group.
 */
export async function executeStep(ctx: StepContext, stepIndex: number, step: PlanStep, startStatement: number, resumed: boolean): Promise<StepResult> {
  const statements = ctx.engine.renderStep(step);
  return executeStatements(ctx, statements, startStatement, resumed, (next) => setProgress(ctx.client, ctx.runId, stepIndex, next), stepIndex);
}
