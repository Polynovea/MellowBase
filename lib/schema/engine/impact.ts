// What a plan would do to existing data, counted on the live table: values a destructive step deletes,
// and rows that would make a step fail (published entries with no value for a newly required field,
// duplicate values for a new unique index). Read-only; runs as the app role.
import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { withSummaries, type DescribeContext } from "@/lib/schema/engine/describe";
import type { MigrationPlan, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import { ident, tableRef } from "@/lib/schema/engine/render";

type Executor = Kysely<DB> | Transaction<DB>;

async function countOf(db: Executor, query: RawBuilder<{ n: string }>): Promise<number> {
  const { rows } = await query.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The column's name in the table as it is now, or null if it is not there. Without `live`, the table is
 * the plan's base shape (before this plan's renames). With `live` (the table's recorded shape, e.g. after
 * the expand stage ran), a column already renamed is found under its new name.
 */
function existingName(plan: MigrationPlan, column: string, live?: TableShape | null): string | null {
  if (live?.columns[column]) return column;
  let name = column;
  for (const step of plan.steps) if (step.kind === "rename_column" && step.to === name) name = step.from;
  return (live ?? plan.baseShape)?.columns[name] ? name : null;
}

/**
 * Returns the plan with counts filled in and summaries rewritten to include them. `live` is the table's
 * recorded shape when it may differ from the plan's base (a waiting destructive stage: the expand stage
 * already ran); a column it does not have is not counted.
 */
export async function countDestructiveImpact(db: Executor, plan: MigrationPlan, context: DescribeContext, live?: TableShape | null): Promise<MigrationPlan> {
  if (!plan.baseShape) return withSummaries(plan, context);
  const table = tableRef(plan.table);
  const replaced = new Set(plan.steps.flatMap((s) => (s.kind === "replace_column" ? [s.column.name] : [])));
  const backfilled = new Set(plan.steps.flatMap((s) => (s.kind === "backfill_column" ? [s.column] : [])));
  const retyped = new Set(plan.steps.flatMap((s) => (s.kind === "change_type" ? [s.column] : [])));
  const published = () => countOf(db, sql<{ n: string }>`select count(*) as n from ${table} where _variant = 'published'`);

  const steps: PlanStep[] = [];
  for (const step of plan.steps) {
    switch (step.kind) {
      case "drop_table":
        steps.push({ ...step, affectedRows: await countOf(db, sql<{ n: string }>`select count(*) as n from ${table}`) });
        break;
      case "drop_column": {
        const name = existingName(plan, step.column, live);
        steps.push(name ? { ...step, affectedValues: await countOf(db, sql<{ n: string }>`select count(${ident(name)}) as n from ${table}`) } : step);
        break;
      }
      case "replace_column": {
        const name = existingName(plan, step.column.name, live);
        steps.push({ ...step, affectedValues: name ? await countOf(db, sql<{ n: string }>`select count(${ident(name)}) as n from ${table}`) : 0 });
        break;
      }
      case "set_required": {
        const name = existingName(plan, step.column, live);
        let blocking: number;
        if (backfilled.has(step.column)) blocking = 0;
        else if (!name || (replaced.has(step.column) && step.stage === "destructive")) blocking = await published();
        else blocking = await countOf(db, sql<{ n: string }>`select count(*) as n from ${table} where _variant = 'published' and ${ident(name)} is null`);
        steps.push({ ...step, blockingRows: blocking });
        break;
      }
      case "add_index": {
        if (!step.unique) { steps.push(step); break; }
        const name = existingName(plan, step.column, live);
        if (!name || replaced.has(step.column) || backfilled.has(step.column) || retyped.has(step.column)) { steps.push(step); break; }
        const duplicates = await countOf(db, sql<{ n: string }>`
          select count(*) - count(distinct (${ident(name)}, _variant, _locale)) as n from ${table} where ${ident(name)} is not null`);
        steps.push({ ...step, blockingRows: duplicates });
        break;
      }
      default:
        steps.push(step);
    }
  }
  return withSummaries({ ...plan, steps }, context);
}

/**
 * For a plan that adds back fields whose deletion was waiting (plan.restoredFields): how many saved
 * values each one gets back, counted on the table as it is (the column was never dropped).
 */
export async function countRestoredValues(db: Executor, plan: MigrationPlan): Promise<Array<{ field: string; values: number }>> {
  const restored: Array<{ field: string; values: number }> = [];
  for (const field of plan.restoredFields ?? []) {
    const column = Object.values(plan.baseShape?.columns ?? {}).find((candidate) => candidate.field === field);
    if (!column) continue;
    restored.push({ field, values: await countOf(db, sql<{ n: string }>`select count(${ident(column.name)}) as n from ${tableRef(plan.table)}`) });
  }
  return restored;
}
