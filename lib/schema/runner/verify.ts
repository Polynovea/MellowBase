// Never trust the ledger row.
//
// The app role can insert schema_migration_ledger rows (that is how a change is requested), and the
// worker that reads them runs with owner rights. So the worker never runs the plan stored in the row:
// the engine rebuilds it from trusted state (the model's recorded table, the target model version and
// the stage), and the worker refuses the row unless every check passes:
//
// - the rebuilt plan's hash equals the row's plan_hash (the request was for exactly this change);
// - the plan parses as a plan of a format this runner knows, with no unknown keys anywhere;
// - the engine's validatePlan passes (hash recomputed, names, types, caps, stage rules, and replaying
//   the steps reaches the shapes the plan claims);
// - the plan hash recomputed by the engine equals the row's and the plan's; the shape hashes match
//   the shapes they claim to describe; the row's base hash is the stage's starting hash;
// - the row, the plan and the model agree on workspace, model, api key and table;
// - every step targets the model's own table, content.<content_model_tables.table_name> (or, for a
//   new model, a free table name derived from its api key);
// - every name passes the engine's name rules, and the caps hold;
// - data-deleting steps only appear in the destructive stage, and that stage has a row in
//   schema_migration_confirmations written after the request (only the owner-side
//   polynovea_confirm_schema_stage() writes them).
//
// The worker then executes only SQL it renders itself through the engine's renderStep from the
// checked plan. No SQL text from the row ever runs. The hash is not a signature (the app role could
// compute one too); what keeps a tampered row harmless is that only these well-formed steps on the
// model's own content table can be rendered at all.
import { z } from "zod";
import type pg from "pg";
import { FIELD_TYPES } from "@/lib/schema/fields/types";
import { hashShape } from "@/lib/schema/engine/hash";
import { schemaLimitsFromEnv, type SchemaLimits } from "@/lib/schema/engine/limits";
import { nameProblem, TABLE_NAME_PATTERN, tableNameCandidates } from "@/lib/schema/engine/names";
import { PG_COLUMN_TYPES, type MigrationPlan, type PlanStage, type PlanStep, type TableShape } from "@/lib/schema/engine/plan";
import { RefusedError } from "@/lib/schema/runner/errors";
import { kyselyOn, type SchemaEngine } from "@/lib/schema/runner/engine";

export interface LedgerRow {
  id: string;
  workspace_id: string;
  content_model_id: string | null;
  model_api_key: string;
  table_name: string;
  stage: string;
  status: string;
  plan_hash: string;
  base_shape_hash: string | null;
  target_schema_hash: string | null;
  plan_json: unknown;
  target_version_id: string | null;
  requested_by: string | null;
  confirmed_by: string | null;
  confirmed_at: string | Date | null;
  attempts: number;
  created_at?: string | Date;
}

export interface StageStep {
  /** Position in plan.steps. */
  planIndex: number;
  step: PlanStep;
}

export interface VerifiedStage {
  ledgerId: string;
  plan: MigrationPlan;
  stage: PlanStage;
  /** The stage's steps in plan order. */
  steps: StageStep[];
  /** True when the model has no table yet (first stage creates it). */
  createsTable: boolean;
}

// ── Plan schema (strict: unknown keys are refused at every level) ───────────────────────────────────

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const name = z.string().max(63);
const pgType = z.enum(PG_COLUMN_TYPES);
const fieldType = z.enum(FIELD_TYPES);

const columnShape = z.strictObject({
  name,
  fieldType,
  pgType,
  requiredWhenPublished: z.boolean(),
  unique: z.boolean(),
  indexed: z.boolean(),
  foreignKey: z.strictObject({ onDelete: z.enum(["restrict", "set_null"]) }).optional(),
});

const tableShape = z.strictObject({ table: name, columns: z.record(name, columnShape) });
const count = z.number().int().nonnegative().optional();
const stepBase = { stage: z.enum(["expand", "destructive"]), summary: z.string().max(500), table: name };

const planStep = z.discriminatedUnion("kind", [
  z.strictObject({ ...stepBase, kind: z.literal("create_table"), columns: z.array(columnShape).max(2_000) }),
  z.strictObject({ ...stepBase, kind: z.literal("drop_table"), affectedRows: count }),
  z.strictObject({ ...stepBase, kind: z.literal("add_column"), column: columnShape }),
  z.strictObject({ ...stepBase, kind: z.literal("drop_column"), column: name, affectedValues: count }),
  z.strictObject({ ...stepBase, kind: z.literal("rename_column"), from: name, to: name, column: columnShape }),
  z.strictObject({ ...stepBase, kind: z.literal("backfill_column"), column: name, pgType, value: z.unknown() }),
  z.strictObject({ ...stepBase, kind: z.literal("drop_field_metadata"), field: name }),
  z.strictObject({ ...stepBase, kind: z.literal("change_type"), column: name, from: pgType, to: pgType, fromField: fieldType, toField: fieldType }),
  z.strictObject({ ...stepBase, kind: z.literal("change_field_type"), column: name, fromField: fieldType, toField: fieldType }),
  z.strictObject({ ...stepBase, kind: z.literal("replace_column"), column: columnShape, fromField: fieldType, fromPgType: pgType, affectedValues: count }),
  z.strictObject({ ...stepBase, kind: z.literal("set_required"), column: name, blockingRows: count }),
  z.strictObject({ ...stepBase, kind: z.literal("drop_required"), column: name }),
  z.strictObject({ ...stepBase, kind: z.literal("add_index"), column: name, unique: z.boolean(), blockingRows: count }),
  z.strictObject({ ...stepBase, kind: z.literal("drop_index"), column: name, unique: z.boolean() }),
  z.strictObject({ ...stepBase, kind: z.literal("add_foreign_key"), column: name, onDelete: z.enum(["restrict", "set_null"]) }),
  z.strictObject({ ...stepBase, kind: z.literal("drop_foreign_key"), column: name }),
]);

const planSchema = z.strictObject({
  formatVersion: z.literal(1),
  workspaceId: z.uuid(),
  modelId: z.uuid(),
  modelApiKey: name,
  table: name,
  baseShapeHash: hash,
  expandedShapeHash: hash,
  targetShapeHash: hash,
  targetSchemaHash: hash.nullable(),
  planHash: hash,
  baseShape: tableShape.nullable(),
  expandedShape: tableShape.nullable(),
  targetShape: tableShape.nullable(),
  steps: z.array(planStep).max(5_000),
  requiresConfirmation: z.boolean(),
  notes: z.array(z.string().max(1_000)).max(100),
});

/** Steps that delete data: only ever in the destructive stage. */
const DESTRUCTIVE_KINDS: ReadonlySet<PlanStep["kind"]> = new Set(["drop_table", "drop_column", "replace_column"]);

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────

export function parsePlan(planJson: unknown): MigrationPlan {
  const value = typeof planJson === "string" ? safeJson(planJson) : planJson;
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) throw new RefusedError("plan_malformed");
  return parsed.data as MigrationPlan;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RefusedError("plan_malformed");
  }
}

export function stageBaseHash(plan: MigrationPlan, stage: PlanStage): string {
  return stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash;
}

/** Every column name a step refers to. */
export function stepColumnNames(step: PlanStep): string[] {
  switch (step.kind) {
    case "create_table":
      return step.columns.map((column) => column.name);
    case "drop_table":
      return [];
    case "add_column":
    case "replace_column":
      return [step.column.name];
    case "rename_column":
      return [step.from, step.to, step.column.name];
    case "drop_field_metadata":
      return [step.field];
    default:
      return [step.column];
  }
}

function assertFieldName(value: string) {
  if (nameProblem(value, "field")) throw new RefusedError("plan_name_rejected");
}

function assertShape(shape: TableShape | null, expectedHash: string, table: string) {
  if (hashShape(shape) !== expectedHash) throw new RefusedError("plan_shape_hash_mismatch");
  if (!shape) return;
  if (shape.table !== table) throw new RefusedError("plan_target_mismatch");
  for (const [key, column] of Object.entries(shape.columns)) {
    if (column.name !== key) throw new RefusedError("plan_malformed");
    assertFieldName(key);
  }
}

function indexCount(shape: TableShape | null): number {
  if (!shape) return 0;
  return Object.values(shape.columns).filter((column) => column.unique || column.indexed || column.foreignKey).length;
}

/**
 * Checks that need only the row and the plan (no database). `planSource` is the plan to check: the
 * worker passes the plan the engine rebuilt from trusted state; the unit tests pass plan_json.
 */
export function verifyRowAgainstPlan(
  row: LedgerRow,
  engine: Pick<SchemaEngine, "computePlanHash" | "validatePlan">,
  limits: SchemaLimits = schemaLimitsFromEnv(),
  planSource: unknown = row.plan_json,
): Omit<VerifiedStage, "createsTable"> {
  if (row.stage !== "expand" && row.stage !== "destructive") throw new RefusedError("ledger_stage_invalid");
  const stage: PlanStage = row.stage;
  const plan = parsePlan(planSource);

  let recomputed: string;
  try {
    recomputed = engine.computePlanHash(plan);
  } catch {
    throw new RefusedError("plan_malformed");
  }
  if (row.plan_hash !== plan.planHash || recomputed !== plan.planHash) throw new RefusedError("plan_hash_mismatch");
  if (row.base_shape_hash !== stageBaseHash(plan, stage)) throw new RefusedError("ledger_base_hash_mismatch");
  if (row.workspace_id !== plan.workspaceId || row.content_model_id !== plan.modelId) throw new RefusedError("plan_target_mismatch");
  if (row.model_api_key !== plan.modelApiKey || row.table_name !== plan.table) throw new RefusedError("plan_target_mismatch");

  if (!TABLE_NAME_PATTERN.test(plan.table)) throw new RefusedError("plan_target_mismatch");
  if (nameProblem(plan.modelApiKey, "model")) throw new RefusedError("plan_name_rejected");
  assertShape(plan.baseShape, plan.baseShapeHash, plan.table);
  assertShape(plan.expandedShape, plan.expandedShapeHash, plan.table);
  assertShape(plan.targetShape, plan.targetShapeHash, plan.table);

  for (const step of plan.steps) {
    if (step.table !== plan.table) throw new RefusedError("plan_target_mismatch");
    for (const column of stepColumnNames(step)) assertFieldName(column);
    if (DESTRUCTIVE_KINDS.has(step.kind) && step.stage !== "destructive") throw new RefusedError("plan_destructive_in_expand");
  }

  for (const shape of [plan.expandedShape, plan.targetShape]) {
    if (shape && Object.keys(shape.columns).length > limits.maxFieldsPerModel) throw new RefusedError("cap_fields_exceeded");
    if (indexCount(shape) > limits.maxIndexesPerModel) throw new RefusedError("cap_indexes_exceeded");
  }

  // The engine's own validation on top: the steps must replay to the shapes the plan claims.
  try {
    engine.validatePlan(plan, { limits });
  } catch (error) {
    const code = (error as { name?: string; code?: string }).name === "SchemaEngineError" ? (error as { code: string }).code : "invalid_plan";
    throw new RefusedError(code === "cap_exceeded" ? "cap_exceeded" : "invalid_plan");
  }

  if (stage === "destructive" && !plan.requiresConfirmation) throw new RefusedError("destructive_not_confirmed");

  const steps = plan.steps.map((step, planIndex) => ({ planIndex, step })).filter(({ step }) => step.stage === stage);
  if (steps.length === 0) throw new RefusedError("stage_has_no_steps");
  return { ledgerId: row.id, plan, stage, steps };
}

/** Every check, including the ones against the database (model, its table, the model cap). */
export async function verifyLedgerRow(
  client: pg.ClientBase,
  row: LedgerRow,
  engine: Pick<SchemaEngine, "computePlanHash" | "validatePlan" | "buildPlanFromTrustedState">,
  limits: SchemaLimits = schemaLimitsFromEnv(),
): Promise<VerifiedStage> {
  // The plan to run comes from trusted state, never from plan_json.
  let trusted: MigrationPlan;
  try {
    trusted = await engine.buildPlanFromTrustedState(kyselyOn(client), row);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new RefusedError(typeof code === "string" && /^[a-z0-9_]{1,80}$/.test(code) ? code : "trusted_plan_unavailable");
  }
  const verified = verifyRowAgainstPlan(row, engine, limits, trusted);
  const { plan, stage, steps } = verified;

  if (stage === "destructive") {
    const { rows: confirmations } = await client.query(
      `select 1 from public.schema_migration_confirmations c
         join public.schema_migration_ledger l on l.id = c.ledger_id
        where c.ledger_id = $1 and c.created_at > l.created_at`,
      [row.id],
    );
    if (confirmations.length === 0) throw new RefusedError("destructive_not_confirmed");
  }

  const { rows: [model] } = await client.query<{ workspace_id: string; api_key: string }>(
    "select workspace_id, api_key from public.content_models where id = $1",
    [plan.modelId],
  );
  if (!model || model.workspace_id !== plan.workspaceId || model.api_key !== plan.modelApiKey) throw new RefusedError("plan_target_mismatch");

  const { rows: tables } = await client.query<{ content_model_id: string; workspace_id: string; table_name: string }>(
    "select content_model_id, workspace_id, table_name from public.content_model_tables where content_model_id = $1 or table_name = $2",
    [plan.modelId, plan.table],
  );
  const own = tables.find((table) => table.content_model_id === plan.modelId);
  if (tables.some((table) => table.content_model_id !== plan.modelId)) throw new RefusedError("plan_target_mismatch");

  if (own) {
    if (own.table_name !== plan.table || own.workspace_id !== plan.workspaceId) throw new RefusedError("plan_target_mismatch");
    if (steps.some(({ step }) => step.kind === "create_table")) throw new RefusedError("plan_target_mismatch");
    return { ...verified, createsTable: false };
  }

  // No table yet: only a first expand stage that creates it, under a name derived from the api key.
  if (stage !== "expand" || steps[0]?.step.kind !== "create_table" || plan.baseShape !== null) throw new RefusedError("plan_target_mismatch");
  if (!tableNameCandidates(plan.workspaceId, plan.modelApiKey).includes(plan.table)) throw new RefusedError("plan_target_mismatch");
  const { rows: [{ models }] } = await client.query<{ models: number }>("select count(*)::int as models from public.content_model_tables");
  if (models >= limits.maxModels) throw new RefusedError("cap_models_exceeded");
  return { ...verified, createsTable: true };
}
