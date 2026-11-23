// Re-checks a plan read back from the ledger before anything runs it. polynovea_app can write ledger
// rows, so a stored plan is untrusted input: its hash is recomputed, every name and type is checked
// against the rules, the caps are applied, data-deleting steps must sit in the destructive stage, and
// replaying the steps must reproduce the plan's own shape hashes. Pure: no database access (the
// database-side checks are in assertStageCurrent, apply.ts).
import { indexCount, isPgColumnType } from "@/lib/schema/engine/columns";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import { hashShape } from "@/lib/schema/engine/hash";
import { DEFAULT_SCHEMA_LIMITS, type SchemaLimits } from "@/lib/schema/engine/limits";
import { COLUMN_NAME_PATTERN, nameProblem, TABLE_NAME_PATTERN } from "@/lib/schema/engine/names";
import type { ColumnShape, MigrationPlan, PlanStage, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import { applyStepToShape, computePlanHash } from "@/lib/schema/engine/planner";

/** Steps that delete data: only ever in the destructive stage, which needs the typed confirmation. */
export const DATA_DELETING_STEPS: ReadonlySet<PlanStep["kind"]> = new Set(["drop_column", "drop_table", "replace_column"]);
/** What may follow a replace in the destructive stage: the new column's constraints. */
const DESTRUCTIVE_STAGE_STEPS: ReadonlySet<PlanStep["kind"]> = new Set([...DATA_DELETING_STEPS, "backfill_column", "set_required", "add_index", "add_foreign_key"]);
const FK_ACTIONS = new Set(["restrict", "set_null"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (why: string) => new SchemaEngineError("invalid_plan", `This change plan cannot be run: ${why}. Review the change again.`);

function checkColumn(column: ColumnShape | undefined, where: string): void {
  if (!column || typeof column !== "object") throw invalid(`${where} has no column`);
  if (typeof column.name !== "string" || !COLUMN_NAME_PATTERN.test(column.name)) throw invalid(`${where} has an invalid column name`);
  if (nameProblem(column.field, "field")) throw invalid(`${where} has an invalid field key`);
  if (!isPgColumnType(column.pgType)) throw invalid(`${where} has an unknown column type`);
  if (column.foreignKey && !FK_ACTIONS.has(column.foreignKey.onDelete)) throw invalid(`${where} has an unknown link rule`);
}

function checkShape(shape: TableShape | null, table: string, label: string): void {
  if (shape === null) return;
  if (!shape || typeof shape !== "object" || shape.table !== table || !shape.columns || typeof shape.columns !== "object") throw invalid(`the ${label} shape is malformed`);
  for (const [key, column] of Object.entries(shape.columns)) {
    checkColumn(column, `the ${label} shape`);
    if (column.name !== key) throw invalid(`the ${label} shape is malformed`);
  }
}

/** Every column name a step introduces or touches, and every field key it names. */
function stepNames(step: PlanStep): { columns: string[]; fields: string[] } {
  switch (step.kind) {
    case "create_table": return { columns: step.columns.map((c) => c.name), fields: [] };
    case "drop_table": return { columns: [], fields: [] };
    case "add_column": return { columns: [step.column.name], fields: [] };
    case "replace_column": return { columns: [step.column.name], fields: [] };
    case "rename_column": return { columns: [step.from, step.to, step.column?.name], fields: [step.field] };
    case "drop_column": return { columns: [step.column], fields: [step.field] };
    case "drop_field_metadata": return { columns: [], fields: [step.field] };
    default: return { columns: [step.column], fields: [] };
  }
}

function replay(shape: TableShape | null, steps: PlanStep[]): TableShape | null {
  try {
    return steps.reduce<TableShape | null>((current, step) => applyStepToShape(current, step), shape);
  } catch {
    throw invalid("its steps do not apply to the table");
  }
}

/** Throws SchemaEngineError("invalid_plan") unless `plan` is well formed and within the rules and caps. */
export function validatePlan(plan: MigrationPlan, options: { limits?: SchemaLimits } = {}): void {
  const limits = options.limits ?? DEFAULT_SCHEMA_LIMITS;
  if (!plan || typeof plan !== "object" || plan.formatVersion !== 1 || !Array.isArray(plan.steps)) throw invalid("its format is not one this version understands");
  if (!UUID.test(String(plan.workspaceId)) || !UUID.test(String(plan.modelId))) throw invalid("it names no valid model");
  if (typeof plan.table !== "string" || !TABLE_NAME_PATTERN.test(plan.table)) throw invalid("its table name is not a model table");
  if (nameProblem(plan.modelApiKey, "model")) throw invalid("its model API key breaks the name rules");
  if (plan.targetVersionId !== null && plan.targetVersionId !== undefined && !UUID.test(String(plan.targetVersionId))) throw invalid("it names no valid schema version");
  if (computePlanHash(plan) !== plan.planHash) throw invalid("it was altered after it was made");

  let stage: PlanStage = "expand";
  for (const step of plan.steps) {
    if (!step || typeof step !== "object") throw invalid("a step is malformed");
    if (step.table !== plan.table) throw invalid("a step touches another table");
    if (step.stage !== "expand" && step.stage !== "destructive") throw invalid("a step has no stage");
    if (step.stage === "expand" && stage === "destructive") throw invalid("its stages are out of order");
    stage = step.stage;
    if (step.stage === "expand" && DATA_DELETING_STEPS.has(step.kind)) throw invalid("a step that deletes data is not in the confirmed stage");
    if (step.stage === "destructive" && !DESTRUCTIVE_STAGE_STEPS.has(step.kind)) throw invalid("the confirmed stage holds a step that belongs earlier");
    const names = stepNames(step);
    for (const name of names.columns) if (typeof name !== "string" || !COLUMN_NAME_PATTERN.test(name)) throw invalid("a step uses an invalid column name");
    for (const name of names.fields) if (nameProblem(name, "field")) throw invalid("a step uses an invalid field key");
    if (step.kind === "create_table") step.columns.forEach((c) => checkColumn(c, "a new table"));
    if (step.kind === "add_column" || step.kind === "replace_column") checkColumn(step.column, "a new column");
    if (step.kind === "rename_column") checkColumn(step.column, "a renamed column");
    if (step.kind === "add_foreign_key" && !FK_ACTIONS.has(step.onDelete)) throw invalid("a step has an unknown link rule");
    if ((step.kind === "change_type" && (!isPgColumnType(step.from) || !isPgColumnType(step.to))) || (step.kind === "backfill_column" && !isPgColumnType(step.pgType))) {
      throw invalid("a step has an unknown column type");
    }
  }
  const destructive = plan.steps.some((step) => step.stage === "destructive");
  if (plan.requiresConfirmation !== destructive) throw invalid("its confirmation flag does not match its steps");

  checkShape(plan.baseShape, plan.table, "starting");
  checkShape(plan.expandedShape, plan.table, "intermediate");
  checkShape(plan.targetShape, plan.table, "final");
  if (hashShape(plan.baseShape) !== plan.baseShapeHash || hashShape(plan.expandedShape) !== plan.expandedShapeHash || hashShape(plan.targetShape) !== plan.targetShapeHash) {
    throw invalid("it was altered after it was made");
  }
  const expanded = replay(plan.baseShape, plan.steps.filter((s) => s.stage === "expand"));
  if (hashShape(expanded) !== plan.expandedShapeHash) throw invalid("its steps do not reach the shape it claims");
  const final = replay(expanded, plan.steps.filter((s) => s.stage === "destructive"));
  if (hashShape(final) !== plan.targetShapeHash) throw invalid("its steps do not reach the shape it claims");

  if (plan.targetShape) {
    const fields = Object.keys(plan.targetShape.columns).length;
    if (fields > limits.maxFieldsPerModel) throw new SchemaEngineError("cap_exceeded", `A model can have at most ${limits.maxFieldsPerModel} fields; this plan has ${fields}.`);
    const indexes = indexCount(plan.targetShape);
    if (indexes > limits.maxIndexesPerModel) throw new SchemaEngineError("cap_exceeded", `A model can have at most ${limits.maxIndexesPerModel} indexed fields; this plan has ${indexes}.`);
  }
}
