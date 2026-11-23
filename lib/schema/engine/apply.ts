// Loading a model's table state, preparing plans, the gates every runner must keep, and a reference
// executor built from them.
//
// The migration runner (phase 3 wave 2) calls, inside its own owner-role transaction:
//   assertStageCurrent(trx, plan, stage)    validates the plan, locks the model, checks the shape hash
//   ...runs renderStep(step) for each step of the stage, its own way...
//   applyStageBookkeeping(trx, plan, stage) records the new shape, moves or deletes permission rows,
//                                           reserves deleted and renamed-away names for 30 days
// It keeps its own ledger and the typed-confirmation check for the destructive stage.
//
// The tests' reference executor lives in a test-only module outside the public
// index: the migration runner is the only production executor.
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import { describeContextFor } from "@/lib/schema/engine/describe";
import { countDestructiveImpact } from "@/lib/schema/engine/impact";
import { hashShape } from "@/lib/schema/engine/hash";
import { DEFAULT_SCHEMA_LIMITS, POSTGRES_MAX_COLUMNS, type SchemaLimits } from "@/lib/schema/engine/limits";
import { tableNameCandidates } from "@/lib/schema/engine/names";
import type { MigrationPlan, PlanResult, PlanStage, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import { applyStepToShape, buildMigrationPlan, type FieldRename } from "@/lib/schema/engine/planner";
import { CONTENT_SCHEMA } from "@/lib/schema/engine/render";
import { validatePlan } from "@/lib/schema/engine/validate";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

export { SchemaEngineError, type SchemaEngineErrorCode } from "@/lib/schema/engine/errors";

type Executor = Kysely<DB> | Transaction<DB>;

export const NAME_RESERVATION_DAYS = 30;

export interface ModelTableState {
  table: string;
  shape: TableShape;
  hash: string;
  /** The schema version the table was last planned to (null before the first saved version). */
  appliedVersionId: string | null;
}

export async function loadModelTable(db: Executor, modelId: string): Promise<ModelTableState | null> {
  const row = await db.selectFrom("content_model_tables").select(["table_name", "applied_shape", "applied_shape_hash", "applied_version_id"])
    .where("content_model_id", "=", modelId).executeTakeFirst();
  return row ? { table: row.table_name, shape: row.applied_shape as unknown as TableShape, hash: row.applied_shape_hash, appliedVersionId: row.applied_version_id } : null;
}

/** The first free table-name candidate for a new model. The unique constraint settles races. */
export async function chooseTableName(db: Executor, workspaceId: string, apiKey: string): Promise<string> {
  const candidates = tableNameCandidates(workspaceId, apiKey);
  const taken = new Set((await db.selectFrom("content_model_tables").select("table_name").where("table_name", "in", candidates).execute()).map((r) => r.table_name));
  const free = candidates.find((name) => !taken.has(name));
  if (!free) throw new SchemaEngineError("invalid_plan", "No table name is available for this model. Choose another API key.");
  return free;
}

/** Live reservations: deleted field names, renamed-away field names (this model) and deleted model api keys (workspace). */
export async function loadReservedNames(db: Executor, workspaceId: string, modelId: string): Promise<{ fields: Set<string>; renamedFields: Set<string>; models: Set<string> }> {
  const rows = await db.selectFrom("schema_name_reservations").select(["kind", "name", "reason", "content_model_id"])
    .where("workspace_id", "=", workspaceId)
    .where("reserved_until", ">", sql<string>`now()`)
    .where((eb) => eb.or([eb("kind", "=", "model"), eb("content_model_id", "=", modelId)]))
    .execute();
  return {
    fields: new Set(rows.filter((r) => r.kind === "field" && r.reason === "deleted").map((r) => r.name)),
    renamedFields: new Set(rows.filter((r) => r.kind === "field" && r.reason === "renamed").map((r) => r.name)),
    models: new Set(rows.filter((r) => r.kind === "model").map((r) => r.name)),
  };
}

async function countModelTables(db: Executor, excludingModelId: string): Promise<number> {
  const row = await db.selectFrom("content_model_tables").select((eb) => eb.fn.countAll<string>().as("n"))
    .where("content_model_id", "<>", excludingModelId).executeTakeFirst();
  return Number(row?.n ?? 0);
}

export interface PrepareInput {
  workspaceId: string;
  model: { id: string; apiKey: string };
  currentSchema: CanonicalSchema | null;
  targetSchema: CanonicalSchema | null;
  renames?: FieldRename[];
  limits?: SchemaLimits;
}

/** Loads the table's state, builds the plan and counts its impact. Read-only; the app role is enough. */
export async function prepareMigrationPlan(db: Executor, input: PrepareInput): Promise<PlanResult> {
  const state = await loadModelTable(db, input.model.id);
  const table = state?.table ?? (await chooseTableName(db, input.workspaceId, input.model.apiKey));
  const reserved = await loadReservedNames(db, input.workspaceId, input.model.id);
  const result = buildMigrationPlan({
    workspaceId: input.workspaceId,
    modelId: input.model.id,
    modelApiKey: input.model.apiKey,
    table,
    currentShape: state?.shape ?? null,
    currentSchema: input.currentSchema,
    targetSchema: input.targetSchema,
    renames: input.renames,
    limits: input.limits,
    otherModelCount: await countModelTables(db, input.model.id),
    reservedFieldNames: reserved.fields,
    renamedFieldNames: reserved.renamedFields,
    reservedModelNames: reserved.models,
  });
  if (!result.ok) return result;
  const context = describeContextFor(result.plan, input.targetSchema?.name ?? input.currentSchema?.name ?? input.model.apiKey, [input.targetSchema, input.currentSchema]);
  return { ok: true, plan: await countDestructiveImpact(db, result.plan, context) };
}

/**
 * What the user must type to confirm a destructive stage: the model's API key, read from the model row
 * (never from a plan, which may come from the app-writable ledger).
 */
export async function expectedConfirmation(db: Executor, contentModelId: string): Promise<string> {
  const model = await db.selectFrom("content_models").select("api_key").where("id", "=", contentModelId).executeTakeFirst();
  if (!model) throw new SchemaEngineError("not_found", "This model no longer exists.");
  return model.api_key;
}

const stageSteps = (plan: MigrationPlan, stage: PlanStage) => plan.steps.filter((step) => step.stage === stage);

/** The shape hash the table must be at before `stage` runs. */
const stageBaseHash = (plan: MigrationPlan, stage: PlanStage) => (stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash);

/**
 * Validates the plan (it may come from the app-writable ledger), locks the model's rows and checks the
 * table is still at the shape this stage was planned from, that the table name belongs to this model,
 * the model cap, and that no new field takes a reserved name. Call first, inside the transaction that
 * applies the stage. Returns the table's current recorded state (null before the table exists).
 */
export async function assertStageCurrent(
  trx: Transaction<DB>,
  plan: MigrationPlan,
  stage: PlanStage,
  options: { limits?: SchemaLimits } = {},
): Promise<ModelTableState | null> {
  const limits = options.limits ?? DEFAULT_SCHEMA_LIMITS;
  validatePlan(plan, { limits });

  const model = await trx.selectFrom("content_models").select(["id", "workspace_id", "api_key"]).where("id", "=", plan.modelId).forUpdate().executeTakeFirst();
  if (!model || model.workspace_id !== plan.workspaceId || model.api_key !== plan.modelApiKey) {
    throw new SchemaEngineError("not_found", "This model no longer exists.");
  }
  const row = await trx.selectFrom("content_model_tables").selectAll().where("content_model_id", "=", plan.modelId).forUpdate().executeTakeFirst();
  if (row && row.table_name !== plan.table) throw new SchemaEngineError("invalid_plan", "This change plan is for a different table.");
  if (!row && !tableNameCandidates(plan.workspaceId, plan.modelApiKey).includes(plan.table)) {
    throw new SchemaEngineError("invalid_plan", "This change plan is for a different table.");
  }
  if ((row?.applied_shape_hash ?? hashShape(null)) !== stageBaseHash(plan, stage)) {
    throw new SchemaEngineError("stale_plan", "The model changed after this plan was made. Review the change again.");
  }

  const steps = stageSteps(plan, stage);
  if (!row && steps.some((step) => step.kind === "create_table") && (await countModelTables(trx, plan.modelId)) >= limits.maxModels) {
    throw new SchemaEngineError("cap_exceeded", `This install already has ${limits.maxModels} models, the most allowed.`);
  }
  // PostgreSQL's 1,600-column limit counts deleted columns too.
  const adding = steps.filter((step) => step.kind === "add_column" || step.kind === "replace_column").length;
  if (row && adding > 0) {
    const used = await sql<{ n: string }>`
      select count(*) as n from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace s on s.oid = c.relnamespace
      where s.nspname = ${CONTENT_SCHEMA} and c.relname = ${plan.table} and a.attnum > 0`.execute(trx);
    if (Number(used.rows[0]?.n ?? 0) + adding > POSTGRES_MAX_COLUMNS) {
      throw new SchemaEngineError("cap_exceeded", "This model's table has reached PostgreSQL's limit of 1,600 columns, which also counts deleted fields. The table needs a rebuild before more fields can be added.");
    }
  }
  const reserved = await loadReservedNames(trx, plan.workspaceId, plan.modelId);
  if (!row && steps.some((step) => step.kind === "create_table") && reserved.models.has(plan.modelApiKey)) {
    throw new SchemaEngineError("reserved_name", `The model API key "${plan.modelApiKey}" belonged to a model deleted in the last 30 days and cannot be reused yet.`);
  }
  const clash = steps.flatMap((step) => {
    if (step.kind === "rename_column") return reserved.fields.has(step.field) ? [step.field] : [];
    const added = step.kind === "add_column" ? [step.column.field] : step.kind === "create_table" ? step.columns.map((c) => c.field) : [];
    return added.filter((name) => reserved.fields.has(name) || reserved.renamedFields.has(name));
  })[0];
  if (clash) throw new SchemaEngineError("reserved_name", `The field key "${clash}" was deleted or renamed in the last 30 days and cannot be reused yet.`);

  return row ? { table: row.table_name, shape: row.applied_shape as unknown as TableShape, hash: row.applied_shape_hash, appliedVersionId: row.applied_version_id } : null;
}

async function reserveName(trx: Transaction<DB>, plan: MigrationPlan, kind: "field" | "model", name: string, reason: "deleted" | "renamed") {
  await trx.insertInto("schema_name_reservations").values({
    workspace_id: plan.workspaceId,
    content_model_id: kind === "field" ? plan.modelId : null,
    kind,
    name,
    reason,
    reserved_until: sql<string>`now() + make_interval(days => ${NAME_RESERVATION_DAYS})`,
  }).execute();
}

async function deleteFieldPermissions(trx: Transaction<DB>, plan: MigrationPlan, field?: string): Promise<void> {
  let query = trx.deleteFrom("content_field_permissions").where("content_model_id", "=", plan.modelId);
  if (field !== undefined) query = query.where("field_key", "=", field);
  await query.execute();
}

/**
 * Records what a stage did, in the transaction that ran its DDL: the table's new shape and hash,
 * permission rows moved (renames) or deleted (dropped fields, dropped table), and 30-day name
 * reservations. Call after every statement of the stage has run and before committing.
 */
export async function applyStageBookkeeping(trx: Transaction<DB>, plan: MigrationPlan, stage: PlanStage): Promise<void> {
  const steps = stageSteps(plan, stage);
  if (stage === "expand") {
    // A field whose column waits for the destructive stage has already left the schema: its permission
    // rows go now, so nothing can grant access to it while it waits (the name is reserved on deletion).
    for (const step of stageSteps(plan, "destructive")) {
      if (step.kind === "drop_column") await deleteFieldPermissions(trx, plan, step.field);
    }
  }
  for (const step of steps) {
    switch (step.kind) {
      case "rename_column":
        await trx.updateTable("content_field_permissions").set({ field_key: step.field, updated_at: sql<string>`now()` })
          .where("content_model_id", "=", plan.modelId).where("field_key", "=", step.column.field).execute();
        // Renaming back releases the name's own rename reservation.
        await trx.deleteFrom("schema_name_reservations").where("content_model_id", "=", plan.modelId).where("kind", "=", "field")
          .where("name", "=", step.field).where("reason", "=", "renamed").execute();
        await reserveName(trx, plan, "field", step.column.field, "renamed");
        break;
      case "drop_field_metadata":
      case "drop_column": {
        const field = step.field;
        await deleteFieldPermissions(trx, plan, field);
        await reserveName(trx, plan, "field", field, "deleted");
        break;
      }
      case "drop_table":
        await deleteFieldPermissions(trx, plan);
        await reserveName(trx, plan, "model", plan.modelApiKey, "deleted");
        break;
      default:
        break;
    }
  }

  const before = stage === "expand" ? plan.baseShape : plan.expandedShape;
  const after = steps.reduce<TableShape | null>((shape, step) => applyStepToShape(shape, step), before);
  const hash = stage === "expand" ? plan.expandedShapeHash : plan.targetShapeHash;
  if (hashShape(after) !== hash) throw new SchemaEngineError("invalid_plan", "This change plan does not add up. Review the change again.");
  if (!after) {
    await trx.deleteFrom("content_model_tables").where("content_model_id", "=", plan.modelId).execute();
    return;
  }
  const version = plan.targetVersionId ? { applied_version_id: plan.targetVersionId } : {};
  await trx.insertInto("content_model_tables").values({
    content_model_id: plan.modelId, workspace_id: plan.workspaceId, table_name: plan.table, applied_shape: JSON.stringify(after), applied_shape_hash: hash, ...version,
  }).onConflict((oc) => oc.column("content_model_id").doUpdateSet({
    applied_shape: JSON.stringify(after), applied_shape_hash: hash, updated_at: sql<string>`now()`, ...version,
  })).execute();
}
