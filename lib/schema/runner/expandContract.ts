// Renames and type changes by expand and contract, so no reader or writer of a model's table ever
// sees a column vanish or change under it, and no long exclusive lock is ever taken.
//
// Rename (step rename_column, from → to):
//   expand    add `to`; a BEFORE ROW trigger keeps `from` and `to` equal both ways (writers that know
//             either name keep working); backfill; build `to`'s index, unique, required check and
//             foreign key (what `from` had at that point of the plan) through the engine's renderStep;
//             then drop `from`'s unique index, check and foreign key. When the stage finishes, the
//             engine's bookkeeping switches the model's shape to `to`.
//   contract  later: drop the trigger and `from`.
//
// Type change (step change_type, column c, type A → B):
//   expand    add a hidden column x of type B; a BEFORE ROW trigger fills x from c on every write; a
//             partial "guard" index lists rows where c has a value and x does not (a value that cannot
//             convert); backfill; refuse to go on while the guard finds any; build x's indexes.
//   switch    one short transaction under the 3-second lock timeout: re-check the guard (an index
//             lookup, not a scan), drop the trigger and guard, drop c's indexes and constraints,
//             rename c to a retired name, rename x to c (with its indexes), add the required check and
//             foreign key NOT VALID. Then VALIDATE them, each in its own transaction.
//   contract  later: drop the retired column.
//
// A value that cannot convert never fails the user's save: the trigger leaves x NULL. The stage then
// fails before the switch with type_conversion_failed, c and its data untouched; fixing the value and
// retrying the stage resumes from the check.
//
// The trigger is the one generic function from migration 0074, configured by trigger arguments; the
// backfill is an UPDATE setting the source column to itself, so the trigger converts exactly as it
// does for live writes. Every phase records its position in schema_expand_contract_tasks (owner-only)
// in the transaction that does the work, so a crash resumes where it stopped: the backfill from its
// last key, a concurrent index build after dropping what a failed build left behind.
//
// Contract timing: when a worker of a newer release sees the task (and at least 15 minutes after the
// switch), or 7 days after the switch, whichever comes first. A stage on the same model contracts its
// model's pending tasks first. Both are well inside the 30-day reservation of the old name.
import { createHash } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type pg from "pg";
import { assertIdentifier, derivedName, STORAGE_COLUMNS, TABLE_NAME_PATTERN, type DerivedNameKind } from "@/lib/schema/engine/names";
import { PG_COLUMN_TYPES, type ColumnShape, type MigrationPlan, type PgColumnType, type PlanStep, type RenderedStatement, type TableShape } from "@/lib/schema/engine/plan";
import { applyStepToShape } from "@/lib/schema/engine/planner";
import { compile } from "@/lib/schema/runner/engine";
import { RefusedError, RunnerError } from "@/lib/schema/runner/errors";
import { executeStatements, inLockTimedTransaction, type StepContext, type StepResult } from "@/lib/schema/runner/execute";

export const BACKFILL_BATCH_SIZE = 1_000;

// The storage columns every model table has (the primary key), from the engine.
const ENTRY = sql.id(STORAGE_COLUMNS.entryId);
const VARIANT = sql.id(STORAGE_COLUMNS.variant);
const LOCALE = sql.id(STORAGE_COLUMNS.locale);
export const CONTRACT_MIN_DELAY_MS = 15 * 60_000;
export const CONTRACT_MAX_DELAY_MS = 7 * 24 * 60 * 60_000;

type Phase = "add_column" | "trigger" | "guard_index" | "backfill" | "precheck" | "indexes" | "relax" | "switch" | "validate" | "done";

interface TaskRow {
  id: string;
  kind: "rename" | "change_type";
  table_name: string;
  old_column: string;
  new_column: string;
  retired_column: string | null;
  trigger_name: string;
  status: "expanding" | "awaiting_contract" | "contracted" | "failed" | "rolled_back";
  phase: Phase;
  phase_statement: number;
  /** The last primary key the backfill finished (JSON keys are the logical names). */
  backfill_cursor: { entry_id: string; variant: string; locale: string } | null;
}

export interface ExpandContext extends StepContext {
  ledgerId: string;
  workspaceId: string;
  modelId: string;
  plan: MigrationPlan;
  /** The worker's release (POLYNOVEA_RELEASE_ID, else the package version). */
  releaseId: string;
  batchSize?: number;
  /** Roll a failed type change back at once (default true). Tests turn it off to exercise the operator path. */
  rollbackFailedTypeChange?: boolean;
}

const TASK_COLUMNS = "id, kind, table_name, old_column, new_column, retired_column, trigger_name, status, phase, phase_statement, backfill_cursor";

function derived(prefix: string, ...parts: string[]): string {
  return assertIdentifier(`${prefix}_${createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24)}`);
}

function table(name: string): RawBuilder<unknown> {
  if (!TABLE_NAME_PATTERN.test(name)) throw new RefusedError("plan_target_mismatch");
  return sql.id("content", name);
}

function column(name: string): RawBuilder<unknown> {
  return sql.id(assertIdentifier(name));
}

function columnType(type: PgColumnType): RawBuilder<unknown> {
  if (!(PG_COLUMN_TYPES as readonly string[]).includes(type)) throw new RefusedError("plan_malformed");
  return sql.raw(type);
}

async function run(client: pg.ClientBase, statement: RawBuilder<unknown>) {
  const compiled = compile(statement);
  return client.query(compiled.text, compiled.values);
}

async function setPhase(client: pg.ClientBase, taskId: string, phase: Phase, extra: RawBuilder<unknown> = sql``) {
  await run(client, sql`update public.schema_expand_contract_tasks set phase = ${phase}, phase_statement = 0, updated_at = now() ${extra} where id = ${taskId}`);
}

// ── Task row ─────────────────────────────────────────────────────────────────────────────────────

type ExpandStep = Extract<PlanStep, { kind: "rename_column" | "change_type" }>;

async function openTask(ctx: ExpandContext, planIndex: number, step: ExpandStep): Promise<TaskRow> {
  const isRename = step.kind === "rename_column";
  const oldColumn = isRename ? step.from : step.column;
  const newColumn = isRename ? step.to : derived("x", ctx.ledgerId, String(planIndex), "new");
  const retired = isRename ? null : derived("r", ctx.ledgerId, String(planIndex), "retired");
  const trigger = derived("dw", ctx.ledgerId, String(planIndex), "trigger");
  await run(ctx.client, sql`
    insert into public.schema_expand_contract_tasks
      (ledger_id, step_index, workspace_id, content_model_id, table_name, kind, old_column, new_column, retired_column, trigger_name, status)
    values (${ctx.ledgerId}, ${planIndex}, ${ctx.workspaceId}, ${ctx.modelId}, ${ctx.table}, ${isRename ? "rename" : "change_type"},
            ${oldColumn}, ${newColumn}, ${retired}, ${trigger}, 'expanding')
    on conflict (ledger_id, step_index) do nothing`);
  const { rows: [task] } = await run(ctx.client, sql`
    select ${sql.raw(TASK_COLUMNS)} from public.schema_expand_contract_tasks where ledger_id = ${ctx.ledgerId} and step_index = ${planIndex}`);
  const row = task as TaskRow;
  if (row.table_name !== ctx.table || row.old_column !== oldColumn || row.new_column !== newColumn) throw new RunnerError("expand_task_mismatch");
  return row;
}

/**
 * The column as the plan has it just before step `planIndex` (the stage's starting shape replayed
 * through the steps before it). Its constraints are what the new column must carry; constraint steps
 * later in the plan then run on the new column as usual, so nothing is added twice or skipped.
 */
function columnBefore(ctx: ExpandContext, planIndex: number, name: string): ColumnShape {
  let shape: TableShape | null = ctx.plan.baseShape;
  try {
    for (const earlier of ctx.plan.steps.slice(0, planIndex)) shape = applyStepToShape(shape, earlier);
  } catch {
    throw new RefusedError("plan_malformed");
  }
  const found = shape?.columns[name];
  if (!found) throw new RefusedError("plan_malformed");
  return found;
}

// ── Phases ───────────────────────────────────────────────────────────────────────────────────────

/** Rows with a source value and no destination value: values the trigger could not convert. */
function unconverted(task: TaskRow, fromType: PgColumnType): RawBuilder<unknown> {
  const source = column(task.old_column);
  const hasValue = fromType === "jsonb" ? sql`${source} is not null and jsonb_typeof(${source}) <> 'null'` : sql`${source} is not null`;
  return sql`${hasValue} and ${column(task.new_column)} is null`;
}

async function backfill(ctx: ExpandContext, stepIndex: number, task: TaskRow): Promise<number> {
  const size = ctx.batchSize ?? BACKFILL_BATCH_SIZE;
  let cursor = task.backfill_cursor;
  let batch = 0;
  let retries = 0;
  for (;;) {
    const after = cursor ? sql`where (${ENTRY}, ${VARIANT}, ${LOCALE}) > (${cursor.entry_id}, ${cursor.variant}, ${cursor.locale})` : sql``;
    const result = await inLockTimedTransaction(ctx.client, async () => {
      const { rows: [row] } = await run(ctx.client, sql`
        with batch as (
          select ${ENTRY}, ${VARIANT}, ${LOCALE} from ${table(task.table_name)} ${after}
          order by ${ENTRY}, ${VARIANT}, ${LOCALE} limit ${size}
        ), touched as (
          update ${table(task.table_name)} t set ${column(task.old_column)} = t.${column(task.old_column)}
            from batch b where t.${ENTRY} = b.${ENTRY} and t.${VARIANT} = b.${VARIANT} and t.${LOCALE} = b.${LOCALE}
          returning 1
        )
        select (select count(*) from touched)::int as rows,
               (select jsonb_build_object('entry_id', ${ENTRY}, 'variant', ${VARIANT}, 'locale', ${LOCALE})
                  from batch order by ${ENTRY} desc, ${VARIANT} desc, ${LOCALE} desc limit 1) as last`);
      const { rows: count, last } = row as { rows: number; last: TaskRow["backfill_cursor"] };
      await run(ctx.client, sql`
        update public.schema_expand_contract_tasks
           set backfill_cursor = coalesce(${last ? JSON.stringify(last) : null}::jsonb, backfill_cursor),
               backfilled_rows = backfilled_rows + ${count}, updated_at = now()
         where id = ${task.id}`);
      return { count, last };
    }, ctx.retry);
    retries += result.retries;
    batch += 1;
    await ctx.hooks?.afterBackfillBatch?.({ step: stepIndex, batch, rows: result.value.count });
    if (result.value.count < size || !result.value.last) return retries;
    cursor = result.value.last;
  }
}

/** The constraint and index steps the new column needs, rendered by the engine. */
function constraintStatements(ctx: ExpandContext, target: ColumnShape, onColumn: string, which: "indexes" | "constraints"): RenderedStatement[] {
  const steps: PlanStep[] = [];
  const base = { stage: "expand" as const, summary: "", table: ctx.table, column: onColumn };
  if (which === "indexes") {
    if (target.unique) steps.push({ ...base, kind: "add_index", unique: true });
    else if (target.indexed) steps.push({ ...base, kind: "add_index", unique: false });
  } else {
    if (target.requiredWhenPublished) steps.push({ ...base, kind: "set_required" });
    if (target.foreignKey) steps.push({ ...base, kind: "add_foreign_key", onDelete: target.foreignKey.onDelete });
  }
  return steps.flatMap((step) => ctx.engine.renderStep(step));
}

async function phaseProgress(client: pg.ClientBase, taskId: string, next: number) {
  await run(client, sql`update public.schema_expand_contract_tasks set phase_statement = ${next}, updated_at = now() where id = ${taskId}`);
}

/** The indexes and constraints that use column `attname` of content.<tableName>. */
async function dependentsOf(client: pg.ClientBase, tableName: string, attname: string): Promise<Array<{ name: string; is_constraint: boolean }>> {
  const { rows } = await client.query<{ name: string; is_constraint: boolean }>(
    `with col as (
       select a.attrelid, a.attnum from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'content' and c.relname = $1 and a.attname = $2 and not a.attisdropped)
     select con.conname::text as name, true as is_constraint
       from pg_catalog.pg_constraint con, col
      where con.conrelid = col.attrelid and col.attnum = any (con.conkey)
     union
     select ic.relname::text, false
       from pg_catalog.pg_index i join pg_catalog.pg_class ic on ic.oid = i.indexrelid, col
      where i.indrelid = col.attrelid and col.attnum = any (i.indkey::int2[])
        and not exists (select 1 from pg_catalog.pg_constraint c2 where c2.conindid = i.indexrelid and c2.conrelid = col.attrelid)`,
    [tableName, attname],
  );
  return rows;
}

/** Renames the indexes and constraints on `attname`: each name is mapped by `rename`. Inside the switch transaction. */
async function renameDependents(client: pg.ClientBase, tableName: string, attname: string, rename: (name: string) => string | null) {
  for (const { name, is_constraint: isConstraint } of await dependentsOf(client, tableName, attname)) {
    const next = rename(name);
    if (!next || next === name) continue;
    if (isConstraint) await run(client, sql`alter table ${table(tableName)} rename constraint ${sql.id(name)} to ${sql.id(assertIdentifier(next))}`);
    else await run(client, sql`alter index ${sql.id("content", name)} rename to ${sql.id(assertIdentifier(next))}`);
  }
}

// ── Expand ───────────────────────────────────────────────────────────────────────────────────────

/** Runs (or resumes) the expand of one rename_column or change_type step. */
export async function runExpandStep(ctx: ExpandContext, stepIndex: number, planIndex: number, step: PlanStep): Promise<StepResult> {
  if (step.kind !== "rename_column" && step.kind !== "change_type") throw new RunnerError("not_an_expand_step");
  if (step.table !== ctx.table) throw new RefusedError("plan_target_mismatch");
  const isRename = step.kind === "rename_column";
  const source = columnBefore(ctx, planIndex, isRename ? step.from : step.column);
  const fromType = source.pgType;
  if (step.kind === "change_type" && step.from !== fromType) throw new RefusedError("plan_malformed");
  const toType = isRename ? fromType : step.to;
  // What the column must be once this step is done: renamed, or of the new type, constraints kept.
  const target: ColumnShape = isRename ? { ...source, name: step.to, field: step.field } : { ...source, pgType: toType, fieldType: step.toField };

  let task = await openTask(ctx, planIndex, step);
  if (task.status === "awaiting_contract" || task.status === "contracted") return { statements: 0, lockRetries: 0 };
  if (task.status === "failed" || task.status === "rolled_back") {
    // A rolled-back task starts afresh (its phase was reset); a failed one resumes where it stopped.
    await run(ctx.client, sql`update public.schema_expand_contract_tasks set status = 'expanding', error_ref = null, updated_at = now() where id = ${task.id}`);
    task.status = "expanding";
  }
  let lockRetries = 0;
  const client = ctx.client;
  const tbl = table(task.table_name);

  try {
    if (task.phase === "add_column") {
      lockRetries += (await inLockTimedTransaction(client, async () => {
        await run(client, sql`alter table ${tbl} add column if not exists ${column(task.new_column)} ${columnType(toType)}`);
        await setPhase(client, task.id, "trigger");
      }, ctx.retry)).retries;
      task.phase = "trigger";
    }

    if (task.phase === "trigger") {
      lockRetries += (await inLockTimedTransaction(client, async () => {
        await run(client, sql`
          create or replace trigger ${sql.id(task.trigger_name)} before insert or update on ${tbl}
          for each row execute function public.polynovea_schema_dual_write(${sql.lit(task.old_column)}, ${sql.lit(task.new_column)}, ${sql.lit(isRename ? "sync" : "copy")})`);
        await setPhase(client, task.id, isRename ? "backfill" : "guard_index");
      }, ctx.retry)).retries;
      // Once per rename: a write that sets both names keeps the old column's value (see the trigger).
      if (isRename) ctx.log?.("rename_sync_old_column_wins", { ledgerId: ctx.ledgerId, step: stepIndex });
      task.phase = isRename ? "backfill" : "guard_index";
    }

    if (task.phase === "guard_index") {
      const guard = derived("cx", task.id);
      const statement: RenderedStatement = {
        sql: sql`create index concurrently if not exists ${sql.id(guard)} on ${tbl} (${ENTRY}) where ${unconverted(task, fromType)}`,
        transactional: false,
        lockSensitive: true,
        ownTransaction: false,
      };
      lockRetries += (await executeStatements(ctx, [statement], 0, true, async () => setPhase(client, task.id, "backfill"), stepIndex)).lockRetries;
      task.phase = "backfill";
    }

    if (task.phase === "backfill") {
      lockRetries += await backfill(ctx, stepIndex, task);
      await setPhase(client, task.id, isRename ? "indexes" : "precheck");
      task.phase = isRename ? "indexes" : "precheck";
    }

    if (task.phase === "precheck") {
      // A full read without any lock beyond a plain SELECT: finds bad values before building anything.
      const { rows } = await run(client, sql`select 1 from ${tbl} where ${unconverted(task, fromType)} limit 1`);
      if (rows.length > 0) throw new RunnerError("type_conversion_failed");
      await setPhase(client, task.id, "indexes");
      task.phase = "indexes";
    }

    if (task.phase === "indexes") {
      // A rename gets every constraint now (the trigger keeps both columns equal, so none can reject a
      // save); a type change only its indexes, and its check and foreign key at the switch.
      const statements = [
        ...constraintStatements(ctx, target, task.new_column, "indexes"),
        ...(isRename ? constraintStatements(ctx, target, task.new_column, "constraints") : []),
      ];
      const result = await executeStatements(ctx, statements, task.phase_statement, true, (next) => phaseProgress(client, task.id, next), stepIndex);
      lockRetries += result.lockRetries;
      const next: Phase = isRename ? "relax" : "switch";
      await setPhase(client, task.id, next);
      task.phase = next;
      task.phase_statement = 0;
    }

    if (task.phase === "relax") {
      // Rename: the new column now carries the unique index, check and foreign key, so the old
      // column's go (a later step may relax them on the new name, and the trigger copies every value
      // across, so the old column's own constraints would then reject saves). Its plain index stays
      // until the contract drops the column.
      const base = { stage: "expand" as const, summary: "", table: ctx.table, column: task.old_column };
      const drops: PlanStep[] = [];
      if (source.unique) drops.push({ ...base, kind: "drop_index", unique: true });
      if (source.requiredWhenPublished) drops.push({ ...base, kind: "drop_required" });
      if (source.foreignKey) drops.push({ ...base, kind: "drop_foreign_key" });
      const statements = drops.flatMap((drop) => ctx.engine.renderStep(drop));
      const result = await executeStatements(ctx, statements, task.phase_statement, true, (next) => phaseProgress(client, task.id, next), stepIndex);
      lockRetries += result.lockRetries;
      await finishExpandPhase(ctx, task, "done", true);
      task.phase = "done";
    }

    if (task.phase === "switch") {
      lockRetries += await switchColumns(ctx, task, fromType, target);
      task.phase = "validate";
      task.phase_statement = 0;
    }

    if (task.phase === "validate") {
      const deferred = constraintStatements(ctx, target, task.old_column, "constraints").filter((statement) => !statement.lockSensitive);
      const result = await executeStatements(ctx, deferred, task.phase_statement, true, (next) => phaseProgress(client, task.id, next), stepIndex);
      lockRetries += result.lockRetries;
      await finishExpandPhase(ctx, task, "done", true);
    }
  } catch (error) {
    const code = error instanceof RunnerError ? error.code : null;
    await run(client, sql`update public.schema_expand_contract_tasks set status = 'failed', error_ref = ${code ?? "expand_failed"}, updated_at = now() where id = ${task.id}`).catch(() => undefined);
    // A type change that failed before its switch is undone at once: its copy-trigger would otherwise
    // stay on the table (and fail every save once the source column is gone). A rename keeps its place
    // so a retry resumes the backfill; until then the model's later stages are refused.
    if (!isRename && ctx.rollbackFailedTypeChange !== false) {
      await rollbackExpandTask(ctx, task.id).then(
        () => ctx.log?.("expand_rolled_back", { ledgerId: ctx.ledgerId, step: stepIndex }),
        (rollbackError: unknown) => ctx.log?.("expand_rollback_failed", { ledgerId: ctx.ledgerId, code: rollbackError instanceof RunnerError ? rollbackError.code : "internal_error" }),
      );
    }
    throw error;
  }
  return { statements: 0, lockRetries };
}

async function finishExpandPhase(ctx: ExpandContext, task: TaskRow, next: Phase, readyForContract: boolean) {
  if (!readyForContract) {
    await setPhase(ctx.client, task.id, next);
    return;
  }
  await run(ctx.client, sql`
    update public.schema_expand_contract_tasks
       set phase = ${next}, phase_statement = 0, status = 'awaiting_contract', release_id = ${ctx.releaseId},
           switched_at = coalesce(switched_at, now()),
           contract_min_at = coalesce(switched_at, now()) + make_interval(secs => ${CONTRACT_MIN_DELAY_MS / 1000}),
           contract_after = coalesce(switched_at, now()) + make_interval(secs => ${CONTRACT_MAX_DELAY_MS / 1000}),
           updated_at = now()
     where id = ${task.id}`);
}

/** The type change's switch: one short transaction, or nothing at all. Returns lock retries. */
async function switchColumns(ctx: ExpandContext, task: TaskRow, fromType: PgColumnType, target: ColumnShape): Promise<number> {
  const client = ctx.client;
  const tbl = table(task.table_name);
  const retired = task.retired_column;
  if (!retired) throw new RunnerError("expand_task_mismatch");
  const guard = derived("cx", task.id);
  const finalNames = new Map<string, string>();
  // The hidden column's indexes were built under its own derived names; they take the column's.
  for (const kind of ["uq", "ix", "fk", "ck"] as DerivedNameKind[]) {
    finalNames.set(derivedName(kind, task.table_name, task.new_column), derivedName(kind, task.table_name, task.old_column));
  }
  const immediate = constraintStatements(ctx, target, task.old_column, "constraints").filter((statement) => statement.lockSensitive && statement.transactional);

  const { retries } = await inLockTimedTransaction(client, async () => {
    await run(client, sql`lock table ${tbl} in access exclusive mode`);
    // The guard index makes this a lookup, not a scan, while the table is locked.
    const { rows } = await run(client, sql`select 1 from ${tbl} where ${unconverted(task, fromType)} limit 1`);
    if (rows.length > 0) throw new RunnerError("type_conversion_failed");
    await run(client, sql`drop trigger if exists ${sql.id(task.trigger_name)} on ${tbl}`);
    await run(client, sql`drop index if exists ${sql.id("content", guard)}`);
    // The old column's indexes and constraints go now (metadata only, under the lock already held): the
    // retired column is never read again and must not block a save or an entry's deletion.
    for (const { name, is_constraint: isConstraint } of await dependentsOf(client, task.table_name, task.old_column)) {
      if (isConstraint) await run(client, sql`alter table ${tbl} drop constraint if exists ${sql.id(assertIdentifier(name))}`);
      else await run(client, sql`drop index if exists ${sql.id("content", assertIdentifier(name))}`);
    }
    await run(client, sql`alter table ${tbl} rename column ${column(task.old_column)} to ${column(retired)}`);
    await renameDependents(client, task.table_name, task.new_column, (name) => finalNames.get(name) ?? null);
    await run(client, sql`alter table ${tbl} rename column ${column(task.new_column)} to ${column(task.old_column)}`);
    for (const statement of immediate) {
      const compiled = compile(statement.sql);
      await client.query(compiled.text, compiled.values);
    }
    await setPhase(client, task.id, "validate");
  }, ctx.retry);
  return retries;
}

// ── Roll back ────────────────────────────────────────────────────────────────────────────────────

/** Phases a task can be rolled back from: before a type change's switch, before a rename gives up the old column's constraints. */
const ROLLBACK_PHASES: Record<TaskRow["kind"], ReadonlySet<Phase>> = {
  change_type: new Set<Phase>(["add_column", "trigger", "guard_index", "backfill", "precheck", "indexes", "switch"]),
  rename: new Set<Phase>(["add_column", "trigger", "backfill", "indexes"]),
};

/**
 * Undoes an expand that has not switched: drops its trigger, guard index and new column (with any
 * index built on it) in one short transaction under the 3-second lock timeout, and marks the task
 * rolled_back. The table is then exactly as before the stage. The worker calls it when a type change
 * fails; an operator can call it for any expanding or failed task (npm run worker:schema --
 * --rollback-task=<id>). Refuses (expand_not_rollbackable) once a switch has happened.
 */
export async function rollbackExpandTask(ctx: Pick<StepContext, "client" | "retry">, taskId: string): Promise<void> {
  await inLockTimedTransaction(ctx.client, async () => {
    const { rows: [row] } = await run(ctx.client, sql`select ${sql.raw(TASK_COLUMNS)} from public.schema_expand_contract_tasks where id = ${taskId} for update`);
    const task = row as TaskRow | undefined;
    if (!task) throw new RunnerError("expand_task_not_found");
    if (task.status === "rolled_back") return;
    if ((task.status !== "expanding" && task.status !== "failed") || !ROLLBACK_PHASES[task.kind].has(task.phase)) throw new RunnerError("expand_not_rollbackable");
    const tbl = table(task.table_name);
    await run(ctx.client, sql`drop trigger if exists ${sql.id(assertIdentifier(task.trigger_name))} on ${tbl}`);
    await run(ctx.client, sql`drop index if exists ${sql.id("content", derived("cx", task.id))}`);
    await run(ctx.client, sql`alter table ${tbl} drop column if exists ${column(task.new_column)}`);
    await run(ctx.client, sql`
      update public.schema_expand_contract_tasks
         set status = 'rolled_back', phase = 'add_column', phase_statement = 0, backfill_cursor = null, backfilled_rows = 0, updated_at = now()
       where id = ${task.id}`);
  }, ctx.retry);
}

// ── Contract ─────────────────────────────────────────────────────────────────────────────────────

/** Drops what an expand left behind (trigger, old or retired column). Idempotent. */
export async function contractTask(ctx: Pick<StepContext, "client" | "retry">, task: Pick<TaskRow, "id" | "kind" | "table_name" | "old_column" | "retired_column" | "trigger_name">): Promise<number> {
  const tbl = table(task.table_name);
  const drop = task.kind === "rename" ? task.old_column : task.retired_column;
  if (!drop) throw new RunnerError("expand_task_mismatch");
  const { retries } = await inLockTimedTransaction(ctx.client, async () => {
    await run(ctx.client, sql`drop trigger if exists ${sql.id(assertIdentifier(task.trigger_name))} on ${tbl}`);
    await run(ctx.client, sql`alter table ${tbl} drop column if exists ${column(drop)}`);
    await run(ctx.client, sql`
      update public.schema_expand_contract_tasks set status = 'contracted', contracted_at = now(), updated_at = now() where id = ${task.id}`);
  }, ctx.retry);
  return retries;
}

/**
 * Contracts expand/contract tasks of one model, or of every model when `modelId` is left out. With
 * `dueOnly` false (a new stage on the model is about to run), every task of the model awaiting
 * contract goes, due or not, except the tasks of `exceptLedgerId` (the stage being resumed: its
 * shape has not switched yet). Returns how many it contracted.
 */
export async function contractDue(
  ctx: Pick<StepContext, "client" | "retry">,
  options: { releaseId: string; modelId?: string; dueOnly?: boolean; now?: Date; exceptLedgerId?: string },
): Promise<number> {
  const dueOnly = options.dueOnly ?? true;
  const { rows } = await ctx.client.query(
    `select ${TASK_COLUMNS} from public.schema_expand_contract_tasks
      where status = 'awaiting_contract'
        and ($3::uuid is null or content_model_id = $3)
        and ($5::uuid is null or ledger_id <> $5)
        and (not $4 or contract_after <= $1 or (release_id is distinct from $2 and contract_min_at <= $1))
      order by created_at`,
    [options.now ?? new Date(), options.releaseId, options.modelId ?? null, dueOnly, options.exceptLedgerId ?? null],
  );
  for (const task of rows as TaskRow[]) await contractTask(ctx, task);
  return rows.length;
}
