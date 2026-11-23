// TEST ONLY. A stand-in for the schema engine's renderStep, plan hash and apply gates (phase 3 wave 1)
// until wave 1 pushes them; the runner's tests switch to the real ones then. It renders what wave 1's
// design note describes: tables in `content`, "required" as CHECK (variant <> 'published' OR col IS NOT
// NULL) NOT VALID then VALIDATE, indexes CONCURRENTLY, foreign keys NOT VALID then VALIDATE, and index
// and constraint names from names.ts derivedName. Never imported outside tests.
import { sql, type RawBuilder } from "kysely";
import type { DbExecutor } from "@/lib/db";
import { hashCanonical, hashShape } from "@/lib/schema/engine/hash";
import { derivedName } from "@/lib/schema/engine/names";
import type { ColumnShape, MigrationPlan, PlanStage, PlanStep, RenderedStatement, TableShape } from "@/lib/schema/engine/plan";
import type { SchemaEngine } from "@/lib/schema/runner/engine";

const tx = (statement: RawBuilder<unknown>, lockSensitive = true): RenderedStatement => ({ sql: statement, transactional: true, lockSensitive });
const concurrently = (statement: RawBuilder<unknown>): RenderedStatement => ({ sql: statement, transactional: false, lockSensitive: true });
const t = (table: string) => sql.id("content", table);
const c = (column: string) => sql.id(column);
const type = (column: ColumnShape) => sql.raw(column.pgType);

function columnDefinition(column: ColumnShape) {
  return sql`${c(column.name)} ${type(column)}`;
}

function requiredStatements(table: string, column: string): RenderedStatement[] {
  const name = sql.id(derivedName("ck", table, column));
  return [
    tx(sql`alter table ${t(table)} add constraint ${name} check (variant <> 'published' or ${c(column)} is not null) not valid`),
    tx(sql`alter table ${t(table)} validate constraint ${name}`, false),
  ];
}

function indexStatement(table: string, column: string, unique: boolean): RenderedStatement {
  const name = sql.id(derivedName(unique ? "uq" : "ix", table, column));
  return unique
    ? concurrently(sql`create unique index concurrently ${name} on ${t(table)} (${c(column)}, variant, locale)`)
    : concurrently(sql`create index concurrently ${name} on ${t(table)} (${c(column)})`);
}

function foreignKeyStatements(table: string, column: string, onDelete: "restrict" | "set_null"): RenderedStatement[] {
  const name = sql.id(derivedName("fk", table, column));
  const action = onDelete === "set_null" ? sql.raw("set null") : sql.raw("restrict");
  return [
    tx(sql`alter table ${t(table)} add constraint ${name} foreign key (${c(column)}) references public.content_entries (id) on delete ${action} not valid`),
    tx(sql`alter table ${t(table)} validate constraint ${name}`, false),
  ];
}

export function stubRenderStep(step: PlanStep): RenderedStatement[] {
  switch (step.kind) {
    case "create_table":
      return [
        tx(sql`create table ${t(step.table)} (
          entry_id uuid not null references public.content_entries (id) on delete cascade,
          variant text not null check (variant in ('draft', 'published')),
          locale text not null default '',
          ${sql.join(step.columns.map(columnDefinition))}${step.columns.length ? sql`,` : sql``}
          primary key (entry_id, variant, locale))`, false),
        tx(sql`alter table ${t(step.table)} enable row level security`, false),
        tx(sql`create policy polynovea_app_all on ${t(step.table)} for all to polynovea_app using (true) with check (true)`, false),
      ];
    case "drop_table":
      return [tx(sql`drop table if exists ${t(step.table)}`)];
    case "add_column":
      return [tx(sql`alter table ${t(step.table)} add column ${columnDefinition(step.column)}`)];
    case "drop_column":
      return [tx(sql`alter table ${t(step.table)} drop column if exists ${c(step.column)}`)];
    case "replace_column":
      return [
        tx(sql`alter table ${t(step.table)} drop column if exists ${c(step.column.name)}`),
        tx(sql`alter table ${t(step.table)} add column ${columnDefinition(step.column)}`),
      ];
    case "rename_column":
      return [tx(sql`alter table ${t(step.table)} rename column ${c(step.from)} to ${c(step.to)}`)];
    case "change_type":
      return [tx(sql`alter table ${t(step.table)} alter column ${c(step.column)} type ${sql.raw(step.to)} using ${c(step.column)}::${sql.raw(step.to)}`)];
    case "change_field_type":
      return [];
    case "set_required":
      return requiredStatements(step.table, step.column);
    case "drop_required":
      return [tx(sql`alter table ${t(step.table)} drop constraint if exists ${sql.id(derivedName("ck", step.table, step.column))}`)];
    case "add_index":
      return [indexStatement(step.table, step.column, step.unique)];
    case "drop_index":
      return [concurrently(sql`drop index concurrently if exists ${sql.id("content", derivedName(step.unique ? "uq" : "ix", step.table, step.column))}`)];
    case "add_foreign_key":
      return foreignKeyStatements(step.table, step.column, step.onDelete);
    case "drop_foreign_key":
      return [tx(sql`alter table ${t(step.table)} drop constraint if exists ${sql.id(derivedName("fk", step.table, step.column))}`)];
  }
}

export function stubPlanHash(plan: MigrationPlan): string {
  const { planHash: _ignored, ...rest } = plan;
  return hashCanonical({ plan: rest });
}

async function appliedHash(db: DbExecutor, modelId: string): Promise<string> {
  const { rows } = await sql<{ applied_shape_hash: string }>`select applied_shape_hash from public.content_model_tables where content_model_id = ${modelId}`.execute(db);
  return rows[0]?.applied_shape_hash ?? hashShape(null);
}

export const stubEngine: SchemaEngine = {
  renderStep: stubRenderStep,
  computePlanHash: stubPlanHash,
  async assertStageCurrent(db, plan, stage) {
    const expected = stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash;
    if ((await appliedHash(db, plan.modelId)) !== expected) throw new Error("stage is not current");
  },
  async applyStageBookkeeping(db: DbExecutor, plan: MigrationPlan, stage: PlanStage) {
    const shape: TableShape | null = stage === "expand" ? plan.expandedShape : plan.targetShape;
    if (!shape) {
      await sql`delete from public.content_model_tables where content_model_id = ${plan.modelId}`.execute(db);
      return;
    }
    await sql`
      insert into public.content_model_tables (content_model_id, workspace_id, table_name, applied_shape, applied_shape_hash)
      values (${plan.modelId}, ${plan.workspaceId}, ${plan.table}, ${JSON.stringify(shape)}::jsonb, ${hashShape(shape)})
      on conflict (content_model_id) do update
        set applied_shape = excluded.applied_shape, applied_shape_hash = excluded.applied_shape_hash, updated_at = now()`.execute(db);
  },
};

// ── Plan builder ─────────────────────────────────────────────────────────────────────────────────

export function column(name: string, pgType: ColumnShape["pgType"], extra: Partial<ColumnShape> = {}): ColumnShape {
  const fieldType = ({ text: "text", jsonb: "json", numeric: "number", bigint: "integer", boolean: "boolean", date: "date", timestamptz: "datetime", uuid: "relation" } as const)[pgType];
  return { name, fieldType, pgType, requiredWhenPublished: false, unique: false, indexed: false, ...extra };
}

export function shape(table: string, columns: ColumnShape[]): TableShape {
  return { table, columns: Object.fromEntries(columns.map((item) => [item.name, item])) };
}

type StepInput = PlanStep extends infer S ? (S extends PlanStep ? Omit<S, "summary" | "table"> & { table?: string } : never) : never;

/** A plan from explicit shapes and steps, with every hash filled in. */
export function buildPlan(input: {
  workspaceId: string; modelId: string; modelApiKey: string; table: string;
  base: TableShape | null; expanded: TableShape | null; target?: TableShape | null; steps: StepInput[];
}): MigrationPlan {
  const target = input.target === undefined ? input.expanded : input.target;
  const steps = input.steps.map((step) => ({ summary: step.kind, ...step, table: step.table ?? input.table })) as PlanStep[];
  const plan: MigrationPlan = {
    formatVersion: 1,
    workspaceId: input.workspaceId,
    modelId: input.modelId,
    modelApiKey: input.modelApiKey,
    table: input.table,
    baseShapeHash: hashShape(input.base),
    expandedShapeHash: hashShape(input.expanded),
    targetShapeHash: hashShape(target),
    targetSchemaHash: hashCanonical({ schema: input.modelApiKey }),
    planHash: "",
    baseShape: input.base,
    expandedShape: input.expanded,
    targetShape: target,
    steps,
    requiresConfirmation: steps.some((step) => step.stage === "destructive"),
    notes: [],
  };
  plan.planHash = stubPlanHash(plan);
  return plan;
}
