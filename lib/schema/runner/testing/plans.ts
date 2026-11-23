// TEST ONLY. Hand-built plans for the runner's tests, hashed and validated by the real schema engine
// (phase 3 wave 1), and the engine itself as the runner's adapter. Never imported outside tests.
import { computePlanHash, DEFAULT_SCHEMA_LIMITS, hashCanonical, hashShape } from "@/lib/schema/engine";
import type { ColumnShape, MigrationPlan, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import { productionEngine } from "@/lib/schema/runner/engineAdapter";

export const testEngine = productionEngine(DEFAULT_SCHEMA_LIMITS);

export function column(name: string, pgType: ColumnShape["pgType"], extra: Partial<ColumnShape> = {}): ColumnShape {
  const fieldType = ({ text: "text", jsonb: "json", numeric: "number", bigint: "integer", boolean: "boolean", date: "date", timestamptz: "datetime", uuid: "relation" } as const)[pgType];
  return { name, fieldType, pgType, requiredWhenPublished: false, unique: false, indexed: false, ...extra };
}

/** The column with no constraints (what create_table and add_column produce). */
export function bare(shape: ColumnShape): ColumnShape {
  return { ...shape, requiredWhenPublished: false, unique: false, indexed: false, foreignKey: undefined };
}

export function shape(table: string, columns: ColumnShape[]): TableShape {
  return { table, columns: Object.fromEntries(columns.map((item) => [item.name, item])) };
}

export type StepInput = PlanStep extends infer S ? (S extends PlanStep ? Omit<S, "summary" | "table"> & { table?: string } : never) : never;

/** The steps that give a bare column `target`'s constraints, in the planner's order. */
export function constraintSteps(target: ColumnShape): StepInput[] {
  const steps: StepInput[] = [];
  if (target.requiredWhenPublished) steps.push({ kind: "set_required", stage: "expand", column: target.name });
  if (target.unique) steps.push({ kind: "add_index", stage: "expand", column: target.name, unique: true });
  if (target.indexed) steps.push({ kind: "add_index", stage: "expand", column: target.name, unique: false });
  if (target.foreignKey) steps.push({ kind: "add_foreign_key", stage: "expand", column: target.name, onDelete: target.foreignKey.onDelete });
  return steps;
}

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
  plan.planHash = computePlanHash(plan);
  return plan;
}
