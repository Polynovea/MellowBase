// The plan in plain words, one line per step, for the model editor's "review changes" panel.
// Destructive lines carry the number of values they delete once countDestructiveImpact has run.
import type { MigrationPlan, PgColumnType, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import type { CanonicalSchema, FieldType } from "@/lib/schema/fields/types";
import { FIELD_TYPE_REGISTRY } from "@/lib/schema/fields/registry";

export interface DescribeContext {
  modelName: string;
  /** Schemas to take field labels from, first match wins (target first, then current). */
  schemas: (CanonicalSchema | null | undefined)[];
  /** Column name to field key, for columns whose name differs from their key (later shapes win). */
  fieldByColumn?: Record<string, string>;
}

/** Column name to field key over the given shapes, later shapes winning. */
export function fieldsByColumn(...shapes: (TableShape | null | undefined)[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const shape of shapes) for (const column of Object.values(shape?.columns ?? {})) map[column.name] = column.field;
  return map;
}

/** The describe context for a finished plan (labels from the schemas, keys from the plan's shapes). */
export function describeContextFor(plan: MigrationPlan, modelName: string, schemas: (CanonicalSchema | null | undefined)[]): DescribeContext {
  return { modelName, schemas, fieldByColumn: fieldsByColumn(plan.baseShape, plan.expandedShape, plan.targetShape) };
}

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

function typeLabel(type: FieldType): string {
  return FIELD_TYPE_REGISTRY[type]?.label?.toLowerCase() ?? type;
}

function fieldLabel(key: string, context: DescribeContext): string {
  for (const schema of context.schemas) {
    const field = schema?.fields.find((f) => f.key === key);
    if (field?.label && field.label !== key) return `${field.label} (${key})`;
  }
  return key;
}

function deletes(values: number | undefined): string {
  return values === undefined ? "deletes every value it holds" : `deletes ${plural(values, "value", "values")}`;
}

const PG_LABEL: Record<PgColumnType, string> = {
  text: "text", jsonb: "structured data", numeric: "number", bigint: "whole number", boolean: "yes/no",
  date: "date", timestamptz: "date and time", uuid: "link",
};

export function describeStep(step: PlanStep, context: DescribeContext): string {
  const label = (column: string) => fieldLabel(context.fieldByColumn?.[column] ?? column, context);
  switch (step.kind) {
    case "create_table":
      return `Adds the model ${context.modelName} with ${plural(step.columns.length, "stored field", "stored fields")}`;
    case "drop_table":
      return `Deletes the model ${context.modelName} and its table: ${step.affectedRows === undefined ? "deletes every entry's content" : `deletes ${plural(step.affectedRows, "row", "rows")}`}`;
    case "add_column":
      return `Adds a field: ${fieldLabel(step.column.field, context)} (${typeLabel(step.column.fieldType)})`;
    case "drop_column":
      return `Deletes the field ${fieldLabel(step.field ?? step.column, context)}: ${deletes(step.affectedValues)}`;
    case "rename_column":
      return `Renames a field: ${step.column?.field ?? step.from} → ${fieldLabel(step.field ?? step.to, context)} (safe, two steps)`;
    case "change_type":
      return `Changes ${label(step.column)} from ${typeLabel(step.fromField)} to ${typeLabel(step.toField)} (keeps every value)`;
    case "change_field_type":
      return `Changes ${label(step.column)} from ${typeLabel(step.fromField)} to ${typeLabel(step.toField)} (stored values unchanged; existing values are not re-checked)`;
    case "replace_column":
      return `Changes ${fieldLabel(step.column.field, context)} from ${typeLabel(step.fromField)} to ${typeLabel(step.column.fieldType)}: existing ${PG_LABEL[step.fromPgType]} values cannot be converted, so this ${deletes(step.affectedValues)}`;
    case "backfill_column":
      return `Fills empty values of ${label(step.column)} with its default value`;
    case "drop_field_metadata":
      return `Removes the field ${fieldLabel(step.field, context)} (its stored links are kept)`;
    case "set_required":
      return `Makes ${label(step.column)} required when published${step.blockingRows ? `: blocked until ${plural(step.blockingRows, "published entry has", "published entries have")} a value` : ""}`;
    case "drop_required":
      return `Makes ${label(step.column)} optional`;
    case "add_index":
      return step.unique
        ? `Makes ${label(step.column)} unique${step.blockingRows ? `: blocked until ${plural(step.blockingRows, "duplicate value is", "duplicate values are")} changed` : ""}`
        : `Indexes ${label(step.column)} for faster filtering and sorting`;
    case "drop_index":
      return step.unique ? `Allows duplicate values in ${label(step.column)}` : `Removes the filter index on ${label(step.column)}`;
    case "add_foreign_key":
      return `Checks that ${label(step.column)} links to an existing entry (deleting a linked entry ${step.onDelete === "set_null" ? "clears the link" : "is blocked"})`;
    case "drop_foreign_key":
      return `Stops checking that ${label(step.column)} links to an existing entry`;
  }
}

/** Every line of the plan, expand stage first. */
export function describePlan(plan: MigrationPlan): { stage: PlanStep["stage"]; text: string }[] {
  return plan.steps.map((step) => ({ stage: step.stage, text: step.summary }));
}

/** Refreshes each step's summary (after impact counts are filled in). */
export function withSummaries(plan: MigrationPlan, context: DescribeContext): MigrationPlan {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step, summary: describeStep(step, context) })) };
}
