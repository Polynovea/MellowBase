// The planner: diff a model table's physical shape against the target canonical schema and return
// the ordered steps that get from one to the other. Pure: no database access. Inputs that need the
// database (the current shape, reserved names, model count) are loaded by apply.ts.
import { canonicalJson, hashCanonical, hashModelSchema, hashShape } from "@/lib/schema/engine/hash";
import { columnForField, hasNoColumn, indexCount, isLosslessTypeChange, shapeForSchema } from "@/lib/schema/engine/columns";
import { describeStep, type DescribeContext } from "@/lib/schema/engine/describe";
import { DEFAULT_SCHEMA_LIMITS, type SchemaLimits } from "@/lib/schema/engine/limits";
import { nameProblem, TABLE_NAME_PATTERN } from "@/lib/schema/engine/names";
import type { ColumnShape, MigrationPlan, PlanProblem, PlanResult, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

export interface FieldRename {
  from: string;
  to: string;
}

export interface PlanInput {
  workspaceId: string;
  modelId: string;
  modelApiKey: string;
  /** The model's physical table (existing, or the name chosen for a new one). */
  table: string;
  /** The table as it is now; null when it does not exist yet. */
  currentShape: TableShape | null;
  /** The schema the table was last planned from, for labels and fields without a column. */
  currentSchema?: CanonicalSchema | null;
  /** The schema wanted; null deletes the model's table. */
  targetSchema: CanonicalSchema | null;
  /** Explicit renames. Without one, a changed key is a drop (destructive) plus an add. */
  renames?: FieldRename[];
  limits?: SchemaLimits;
  /** Model tables in the install other than this one (for the model cap). */
  otherModelCount?: number;
  /** Field names of this model deleted within 30 days: no new field and no rename may take them. */
  reservedFieldNames?: Iterable<string>;
  /**
   * Field names this model renamed away from within 30 days: no new field may take them, but a rename
   * may (renaming back is safe, since permission rows move with a rename).
   */
  renamedFieldNames?: Iterable<string>;
  /** Model api keys reserved in this workspace. */
  reservedModelNames?: Iterable<string>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The shape after one step. Used to build plans and, by apply.ts, to record the applied shape. */
export function applyStepToShape(shape: TableShape | null, step: PlanStep): TableShape | null {
  if (step.kind === "create_table") {
    return { table: step.table, columns: Object.fromEntries(step.columns.map((c) => [c.name, { ...c, requiredWhenPublished: false, unique: false, indexed: false, foreignKey: undefined }])) };
  }
  if (step.kind === "drop_table") return null;
  if (!shape) throw new Error(`Step ${step.kind} needs an existing table`);
  const next = clone(shape);
  const column = (name: string): ColumnShape => {
    const found = next.columns[name];
    if (!found) throw new Error(`Step ${step.kind}: column "${name}" does not exist`);
    return found;
  };
  switch (step.kind) {
    case "add_column":
      if (next.columns[step.column.name]) throw new Error(`Step add_column: column "${step.column.name}" already exists`);
      next.columns[step.column.name] = { ...step.column, requiredWhenPublished: false, unique: false, indexed: false, foreignKey: undefined };
      break;
    case "drop_column":
      column(step.column);
      delete next.columns[step.column];
      break;
    case "rename_column": {
      const current = column(step.from);
      if (next.columns[step.to]) throw new Error(`Step rename_column: column "${step.to}" already exists`);
      delete next.columns[step.from];
      next.columns[step.to] = { ...current, name: step.to };
      break;
    }
    case "change_type":
      Object.assign(column(step.column), { pgType: step.to, fieldType: step.toField });
      break;
    case "change_field_type":
      column(step.column).fieldType = step.toField;
      break;
    case "replace_column":
      column(step.column.name);
      next.columns[step.column.name] = { ...step.column, requiredWhenPublished: false, unique: false, indexed: false, foreignKey: undefined };
      break;
    case "backfill_column":
    case "drop_field_metadata":
      break;
    case "set_required":
      column(step.column).requiredWhenPublished = true;
      break;
    case "drop_required":
      column(step.column).requiredWhenPublished = false;
      break;
    case "add_index":
      column(step.column)[step.unique ? "unique" : "indexed"] = true;
      break;
    case "drop_index":
      column(step.column)[step.unique ? "unique" : "indexed"] = false;
      break;
    case "add_foreign_key":
      column(step.column).foreignKey = { onDelete: step.onDelete };
      break;
    case "drop_foreign_key":
      delete column(step.column).foreignKey;
      break;
  }
  return normalizeShape(next);
}

/** Drops undefined keys so equal shapes hash and compare equal. */
export function normalizeShape(shape: TableShape | null): TableShape | null {
  return shape ? (JSON.parse(canonicalJson(shape)) as TableShape) : null;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<PlanStep, "summary"> & { summary?: string };

/** Steps that bring a bare column (no constraints) up to `target`'s constraints. */
function constraintAdds(table: string, target: ColumnShape, stage: PlanStep["stage"], backfill: unknown): Draft[] {
  const steps: Draft[] = [];
  if (target.requiredWhenPublished && backfill !== undefined) {
    steps.push({ kind: "backfill_column", stage, table, column: target.name, pgType: target.pgType, value: backfill });
  }
  if (target.requiredWhenPublished) steps.push({ kind: "set_required", stage, table, column: target.name });
  if (target.unique) steps.push({ kind: "add_index", stage, table, column: target.name, unique: true });
  if (target.indexed) steps.push({ kind: "add_index", stage, table, column: target.name, unique: false });
  if (target.foreignKey) steps.push({ kind: "add_foreign_key", stage, table, column: target.name, onDelete: target.foreignKey.onDelete });
  return steps;
}

// Expand-stage order: renames, then relaxations (drops of constraints), then type changes, then new
// columns, then new constraints. Destructive stage: drops, then replacements and their constraints.
const EXPAND_ORDER: PlanStep["kind"][] = [
  "rename_column", "drop_foreign_key", "drop_index", "drop_required", "change_type", "change_field_type",
  "create_table", "add_column", "backfill_column", "set_required", "add_index", "add_foreign_key", "drop_field_metadata",
];
const orderOf = (kind: PlanStep["kind"]) => {
  const index = EXPAND_ORDER.indexOf(kind);
  return index < 0 ? EXPAND_ORDER.length : index;
};

function validateInput(input: PlanInput, limits: SchemaLimits): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const target = input.targetSchema;
  if (!TABLE_NAME_PATTERN.test(input.table)) problems.push({ code: "invalid_name", message: `Table name "${input.table}" is not a valid model table name.` });
  if (input.currentShape && input.currentShape.table !== input.table) {
    problems.push({ code: "invalid_schema", message: "The model's table name does not match its recorded shape." });
  }
  if (!target) return problems;

  const apiKeyProblem = nameProblem(target.apiKey, "model");
  if (apiKeyProblem) problems.push(apiKeyProblem);
  if (target.apiKey !== input.modelApiKey) problems.push({ code: "invalid_schema", message: "A model's API key cannot change." });
  if (!input.currentShape && new Set(input.reservedModelNames ?? []).has(target.apiKey)) {
    problems.push({ code: "reserved_name", message: `The model API key "${target.apiKey}" belonged to a model deleted in the last 30 days and cannot be reused yet.` });
  }
  if (!input.currentShape && (input.otherModelCount ?? 0) + 1 > limits.maxModels) {
    problems.push({ code: "cap_exceeded", message: `This install already has ${limits.maxModels} models, the most allowed.` });
  }
  if (target.fields.length > limits.maxFieldsPerModel) {
    problems.push({ code: "cap_exceeded", message: `A model can have at most ${limits.maxFieldsPerModel} fields; this one has ${target.fields.length}.` });
  }

  const seen = new Set<string>();
  for (const field of target.fields) {
    const problem = nameProblem(field.key, "field");
    if (problem) problems.push(problem);
    if (seen.has(field.key)) problems.push({ code: "invalid_schema", message: `Field key "${field.key}" is used twice.` });
    seen.add(field.key);
    if (field.type === "relation" && !field.relation) {
      problems.push({ code: "invalid_schema", message: `Relation field "${field.key}" needs a target model.` });
    }
  }
  if (problems.length) return problems;

  const targetShape = shapeForSchema(input.table, target);
  const indexes = indexCount(targetShape);
  if (indexes > limits.maxIndexesPerModel) {
    problems.push({ code: "cap_exceeded", message: `A model can have at most ${limits.maxIndexesPerModel} indexed fields (unique, indexed or relation); this one has ${indexes}.` });
  }

  const deleted = new Set(input.reservedFieldNames ?? []);
  const renamedAway = new Set(input.renamedFieldNames ?? []);
  const currentColumns = input.currentShape?.columns ?? {};
  const currentFieldKeys = new Set([...Object.keys(currentColumns), ...(input.currentSchema?.fields.map((f) => f.key) ?? [])]);
  const renamedTo = new Set((input.renames ?? []).map((r) => r.to));
  for (const field of target.fields) {
    const isNew = !currentFieldKeys.has(field.key);
    const blocked = renamedTo.has(field.key) ? deleted.has(field.key) : isNew && (deleted.has(field.key) || renamedAway.has(field.key));
    if (blocked) {
      problems.push({ code: "reserved_name", message: `The field key "${field.key}" was deleted or renamed in the last 30 days and cannot be reused yet.` });
    }
  }

  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const rename of input.renames ?? []) {
    const bad = (why: string) => problems.push({ code: "invalid_rename", message: `Cannot rename "${rename.from}" to "${rename.to}": ${why}.` });
    if (!currentColumns[rename.from]) bad(`"${rename.from}" is not a stored field`);
    else if (targetShape.columns[rename.from]) bad(`"${rename.from}" is still in the model`);
    else if (!targetShape.columns[rename.to]) bad(`"${rename.to}" is not a stored field in the new model`);
    else if (currentColumns[rename.to]) bad(`"${rename.to}" already exists`);
    else if (froms.has(rename.from) || tos.has(rename.to)) bad("each field can be renamed once per change");
    froms.add(rename.from);
    tos.add(rename.to);
  }
  return problems;
}

/** Builds the plan, or explains (in plain words) why it cannot be built. */
export function buildMigrationPlan(input: PlanInput): PlanResult {
  const limits = input.limits ?? DEFAULT_SCHEMA_LIMITS;
  let problems: PlanProblem[];
  try {
    problems = validateInput(input, limits);
  } catch (error) {
    problems = [{ code: "invalid_schema", message: error instanceof Error ? error.message : "Invalid schema" }];
  }
  if (problems.length) return { ok: false, problems };

  const { table, targetSchema: target } = input;
  const current = normalizeShape(input.currentShape);
  const targetShape = target ? normalizeShape(shapeForSchema(table, target)) : null;
  const drafts: Draft[] = [];
  const notes: string[] = [];

  if (!target) {
    if (current) drafts.push({ kind: "drop_table", stage: "destructive", table });
  } else if (!current) {
    // Columns in the model's field order (the shape itself is keyed, so its order carries no meaning).
    const columns = target.fields.flatMap((field) => (targetShape!.columns[field.key] ? [targetShape!.columns[field.key]] : []));
    drafts.push({ kind: "create_table", stage: "expand", table, columns });
    for (const field of target.fields) {
      const column = targetShape!.columns[field.key];
      if (column) drafts.push(...constraintAdds(table, column, "expand", undefined));
    }
  } else {
    const work = clone(current);
    for (const rename of input.renames ?? []) {
      drafts.push({ kind: "rename_column", stage: "expand", table, from: rename.from, to: rename.to, column: work.columns[rename.from] });
      work.columns[rename.to] = { ...work.columns[rename.from], name: rename.to };
      delete work.columns[rename.from];
    }

    for (const field of target.fields) {
      const want = targetShape!.columns[field.key];
      if (!want) continue;
      const have = work.columns[field.key];
      if (!have) {
        drafts.push({ kind: "add_column", stage: "expand", table, column: want });
        drafts.push(...constraintAdds(table, want, "expand", field.defaultValue ?? undefined));
        continue;
      }
      if (have.pgType !== want.pgType && !isLosslessTypeChange(have.pgType, want.pgType)) {
        drafts.push({ kind: "replace_column", stage: "destructive", table, column: want, fromField: have.fieldType, fromPgType: have.pgType });
        drafts.push(...constraintAdds(table, want, "destructive", field.defaultValue ?? undefined));
        continue;
      }
      if (have.foreignKey && (!want.foreignKey || want.foreignKey.onDelete !== have.foreignKey.onDelete)) {
        drafts.push({ kind: "drop_foreign_key", stage: "expand", table, column: field.key });
      }
      if (have.unique && !want.unique) drafts.push({ kind: "drop_index", stage: "expand", table, column: field.key, unique: true });
      if (have.indexed && !want.indexed) drafts.push({ kind: "drop_index", stage: "expand", table, column: field.key, unique: false });
      if (have.requiredWhenPublished && !want.requiredWhenPublished) drafts.push({ kind: "drop_required", stage: "expand", table, column: field.key });
      if (have.pgType !== want.pgType) {
        drafts.push({ kind: "change_type", stage: "expand", table, column: field.key, from: have.pgType, to: want.pgType, fromField: have.fieldType, toField: want.fieldType });
      } else if (have.fieldType !== want.fieldType) {
        drafts.push({ kind: "change_field_type", stage: "expand", table, column: field.key, fromField: have.fieldType, toField: want.fieldType });
      }
      if (!have.requiredWhenPublished && want.requiredWhenPublished) {
        if (field.defaultValue !== undefined) drafts.push({ kind: "backfill_column", stage: "expand", table, column: field.key, pgType: want.pgType, value: field.defaultValue });
        drafts.push({ kind: "set_required", stage: "expand", table, column: field.key });
      }
      if (!have.unique && want.unique) drafts.push({ kind: "add_index", stage: "expand", table, column: field.key, unique: true });
      if (!have.indexed && want.indexed) drafts.push({ kind: "add_index", stage: "expand", table, column: field.key, unique: false });
      if (want.foreignKey && (!have.foreignKey || want.foreignKey.onDelete !== have.foreignKey.onDelete)) {
        drafts.push({ kind: "add_foreign_key", stage: "expand", table, column: field.key, onDelete: want.foreignKey.onDelete });
      }
    }

    for (const name of Object.keys(work.columns).sort()) {
      if (!targetShape!.columns[name]) drafts.push({ kind: "drop_column", stage: "destructive", table, column: name });
    }
    const targetKeys = new Set(target.fields.map((f) => f.key));
    const renamedFrom = new Set((input.renames ?? []).map((r) => r.from));
    for (const field of input.currentSchema?.fields ?? []) {
      if (hasNoColumn(field) && !targetKeys.has(field.key) && !renamedFrom.has(field.key)) {
        drafts.push({ kind: "drop_field_metadata", stage: "expand", table, field: field.key });
      }
    }
  }

  if (target) {
    for (const field of target.fields) {
      if (hasNoColumn(field)) notes.push(`"${field.label || field.key}" links to many entries; those links are stored separately, not in the model table.`);
    }
  }

  // Stable order: expand steps first (by kind, then as planned), then destructive steps as planned.
  const indexed = drafts.map((draft, position) => ({ draft, position }));
  const expand = indexed.filter((d) => d.draft.stage === "expand").sort((a, b) => orderOf(a.draft.kind) - orderOf(b.draft.kind) || a.position - b.position);
  const destructive = indexed.filter((d) => d.draft.stage === "destructive");
  const context: DescribeContext = { modelName: target?.name ?? input.currentSchema?.name ?? input.modelApiKey, schemas: [target, input.currentSchema ?? null] };
  const steps = [...expand, ...destructive].map(({ draft }) => ({ ...draft, summary: describeStep(draft as PlanStep, context) }) as PlanStep);

  let expandedShape = current;
  for (const step of steps) if (step.stage === "expand") expandedShape = applyStepToShape(expandedShape, step);
  let finalShape = expandedShape;
  for (const step of steps) if (step.stage === "destructive") finalShape = applyStepToShape(finalShape, step);
  if (canonicalJson(finalShape) !== canonicalJson(targetShape)) {
    throw new Error("Schema engine planner produced steps that do not reach the target shape");
  }

  const base = {
    formatVersion: 1 as const,
    workspaceId: input.workspaceId,
    modelId: input.modelId,
    modelApiKey: input.modelApiKey,
    table,
    baseShapeHash: hashShape(current),
    expandedShapeHash: hashShape(expandedShape),
    targetShapeHash: hashShape(targetShape),
    targetSchemaHash: target ? hashModelSchema(target) : null,
  };
  const plan: MigrationPlan = {
    ...base,
    planHash: hashCanonical({ ...base, steps: steps.map(stepIdentity) }),
    baseShape: current,
    expandedShape,
    targetShape,
    steps,
    requiresConfirmation: steps.some((step) => step.stage === "destructive"),
    notes,
  };
  return { ok: true, plan };
}

/** A step without its text and counts: what the plan hash covers. */
export function stepIdentity(step: PlanStep): Record<string, unknown> {
  const { summary: _summary, ...rest } = step as PlanStep & { affectedValues?: number; affectedRows?: number; blockingRows?: number };
  delete (rest as Record<string, unknown>).affectedValues;
  delete (rest as Record<string, unknown>).affectedRows;
  delete (rest as Record<string, unknown>).blockingRows;
  return rest;
}

/** Recomputes a plan's hash from its contents (the runner checks a stored plan was not altered). */
export function computePlanHash(plan: MigrationPlan): string {
  const { formatVersion, workspaceId, modelId, modelApiKey, table, baseShapeHash, expandedShapeHash, targetShapeHash, targetSchemaHash } = plan;
  return hashCanonical({ formatVersion, workspaceId, modelId, modelApiKey, table, baseShapeHash, expandedShapeHash, targetShapeHash, targetSchemaHash, steps: plan.steps.map(stepIdentity) });
}
