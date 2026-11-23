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
// applyExpandStage/applyDestructiveStage are the reference executor (used by the tests): the same
// gates, every statement in one transaction, no retries. Both need an owner-role connection.
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import { countDestructiveImpact } from "@/lib/schema/engine/impact";
import { hashShape } from "@/lib/schema/engine/hash";
import { DEFAULT_SCHEMA_LIMITS, type SchemaLimits } from "@/lib/schema/engine/limits";
import { tableNameCandidates } from "@/lib/schema/engine/names";
import type { MigrationPlan, PlanResult, PlanStage, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import { applyStepToShape, buildMigrationPlan, type FieldRename } from "@/lib/schema/engine/planner";
import { renderStep } from "@/lib/schema/engine/render";
import { validatePlan } from "@/lib/schema/engine/validate";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

export { SchemaEngineError, type SchemaEngineErrorCode } from "@/lib/schema/engine/errors";

type Executor = Kysely<DB> | Transaction<DB>;

export const NAME_RESERVATION_DAYS = 30;
/** Per-statement lock wait in the reference executor; the runner retries with backoff on top. */
export const DDL_LOCK_TIMEOUT = "3s";

export interface ModelTableState {
  table: string;
  shape: TableShape;
  hash: string;
}

export async function loadModelTable(db: Executor, modelId: string): Promise<ModelTableState | null> {
  const row = await db.selectFrom("content_model_tables").select(["table_name", "applied_shape", "applied_shape_hash"])
    .where("content_model_id", "=", modelId).executeTakeFirst();
  return row ? { table: row.table_name, shape: row.applied_shape as unknown as TableShape, hash: row.applied_shape_hash } : null;
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
  const context = { modelName: input.targetSchema?.name ?? input.currentSchema?.name ?? input.model.apiKey, schemas: [input.targetSchema, input.currentSchema] };
  return { ok: true, plan: await countDestructiveImpact(db, result.plan, context) };
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
  const reserved = await loadReservedNames(trx, plan.workspaceId, plan.modelId);
  if (!row && steps.some((step) => step.kind === "create_table") && reserved.models.has(plan.modelApiKey)) {
    throw new SchemaEngineError("reserved_name", `The model API key "${plan.modelApiKey}" belonged to a model deleted in the last 30 days and cannot be reused yet.`);
  }
  const clash = steps.flatMap((step) => {
    if (step.kind === "rename_column") return reserved.fields.has(step.to) ? [step.to] : [];
    const added = step.kind === "add_column" ? [step.column.name] : step.kind === "create_table" ? step.columns.map((c) => c.name) : [];
    return added.filter((name) => reserved.fields.has(name) || reserved.renamedFields.has(name));
  })[0];
  if (clash) throw new SchemaEngineError("reserved_name", `The field key "${clash}" was deleted or renamed in the last 30 days and cannot be reused yet.`);

  return row ? { table: row.table_name, shape: row.applied_shape as unknown as TableShape, hash: row.applied_shape_hash } : null;
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
  for (const step of steps) {
    switch (step.kind) {
      case "rename_column":
        await trx.updateTable("content_field_permissions").set({ field_key: step.to, updated_at: sql<string>`now()` })
          .where("content_model_id", "=", plan.modelId).where("field_key", "=", step.from).execute();
        // Renaming back releases the name's own rename reservation.
        await trx.deleteFrom("schema_name_reservations").where("content_model_id", "=", plan.modelId).where("kind", "=", "field")
          .where("name", "=", step.to).where("reason", "=", "renamed").execute();
        await reserveName(trx, plan, "field", step.from, "renamed");
        break;
      case "drop_field_metadata":
      case "drop_column": {
        const field = step.kind === "drop_column" ? step.column : step.field;
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
  await trx.insertInto("content_model_tables").values({
    content_model_id: plan.modelId, workspace_id: plan.workspaceId, table_name: plan.table, applied_shape: JSON.stringify(after), applied_shape_hash: hash,
  }).onConflict((oc) => oc.column("content_model_id").doUpdateSet({
    applied_shape: JSON.stringify(after), applied_shape_hash: hash, updated_at: sql<string>`now()`,
  })).execute();
}

/** The reference executor's loop: every statement of the stage in the caller's transaction, indexes not concurrent. */
async function runStage(trx: Transaction<DB>, plan: MigrationPlan, stage: PlanStage): Promise<void> {
  await sql`select set_config('lock_timeout', ${DDL_LOCK_TIMEOUT}, true)`.execute(trx);
  for (const step of stageSteps(plan, stage)) {
    for (const statement of renderStep(step, { concurrentIndexes: false })) await statement.sql.execute(trx);
  }
}

function ledgerRow(plan: MigrationPlan, stage: PlanStage, requestedBy: string | null) {
  return {
    workspace_id: plan.workspaceId, content_model_id: plan.modelId, model_api_key: plan.modelApiKey, table_name: plan.table,
    stage, plan_hash: plan.planHash, base_shape_hash: stageBaseHash(plan, stage), target_schema_hash: plan.targetSchemaHash,
    plan_json: JSON.stringify(plan), requested_by: requestedBy,
  };
}

export interface ExpandResult {
  ledgerId: string;
  /** The ledger row of the destructive stage, waiting for the typed model name; null if there is none. */
  awaitingConfirmationId: string | null;
}

/**
 * Reference executor: runs the plan's expand stage in one transaction and records it; queues the
 * destructive stage (if any) as awaiting confirmation. Needs an owner-role connection.
 */
export async function applyExpandStage(
  db: Kysely<DB>,
  args: { plan: MigrationPlan; requestedBy: string | null; limits?: SchemaLimits },
): Promise<ExpandResult> {
  const { plan, requestedBy } = args;
  const startedAt = new Date().toISOString();
  try {
    return await db.transaction().execute(async (trx) => {
      await assertStageCurrent(trx, plan, "expand", { limits: args.limits });
      await runStage(trx, plan, "expand");
      await applyStageBookkeeping(trx, plan, "expand");

      const ledger = await trx.insertInto("schema_migration_ledger").values({
        ...ledgerRow(plan, "expand", requestedBy), status: "succeeded", attempts: 1, started_at: startedAt, finished_at: new Date().toISOString(),
      }).returning("id").executeTakeFirstOrThrow();
      // Any destructive stage queued by an earlier plan no longer matches this table.
      await trx.updateTable("schema_migration_ledger").set({ status: "superseded", finished_at: new Date().toISOString() })
        .where("content_model_id", "=", plan.modelId).where("status", "=", "awaiting_confirmation").execute();
      let awaitingConfirmationId: string | null = null;
      if (plan.requiresConfirmation) {
        const awaiting = await trx.insertInto("schema_migration_ledger").values({ ...ledgerRow(plan, "destructive", requestedBy), status: "awaiting_confirmation" })
          .returning("id").executeTakeFirstOrThrow();
        awaitingConfirmationId = awaiting.id;
      }
      return { ledgerId: ledger.id, awaitingConfirmationId };
    });
  } catch (error) {
    if (error instanceof SchemaEngineError) throw error;
    const ref = randomUUID();
    console.error("[schema-engine] expand stage failed", { modelId: String(plan?.modelId), ref }, error);
    await db.insertInto("schema_migration_ledger").values({
      ...ledgerRow(plan, "expand", requestedBy), status: "failed", error_ref: ref, attempts: 1, started_at: startedAt, finished_at: new Date().toISOString(),
    }).execute().catch((ledgerError: unknown) => console.error("[schema-engine] could not record failure", { ref }, ledgerError));
    throw new SchemaEngineError("apply_failed", `The change could not be applied and nothing was changed. Reference: ${ref}`);
  }
}

/**
 * Reference executor: runs a destructive stage queued by applyExpandStage, once the user has typed
 * the model's api key. Needs an owner-role connection.
 */
export async function applyDestructiveStage(
  db: Kysely<DB>,
  args: { ledgerId: string; confirmation: string; confirmedBy: string | null; limits?: SchemaLimits },
): Promise<{ ledgerId: string }> {
  const startedAt = new Date().toISOString();
  try {
    return await db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom("schema_migration_ledger").selectAll().where("id", "=", args.ledgerId).forUpdate().executeTakeFirst();
      if (!row || row.stage !== "destructive") throw new SchemaEngineError("not_found", "There is no pending deletion with this reference.");
      if (row.status !== "awaiting_confirmation") {
        throw new SchemaEngineError("stage_not_ready", row.status === "superseded"
          ? "The model changed after this deletion was planned. Review the change again."
          : "This deletion is not waiting for confirmation.");
      }
      const plan = row.plan_json as unknown as MigrationPlan;
      if (plan?.planHash !== row.plan_hash || plan?.modelId !== row.content_model_id) {
        throw new SchemaEngineError("invalid_plan", "This change plan was altered after it was made. Review the change again.");
      }
      if (typeof args.confirmation !== "string" || args.confirmation.trim() !== plan.modelApiKey) {
        throw new SchemaEngineError("confirmation_mismatch", `Type the model's API key, ${plan.modelApiKey}, to confirm the deletion.`);
      }
      await assertStageCurrent(trx, plan, "destructive", { limits: args.limits });
      await runStage(trx, plan, "destructive");
      await applyStageBookkeeping(trx, plan, "destructive");

      const now = new Date().toISOString();
      await trx.updateTable("schema_migration_ledger").set({
        status: "succeeded", confirmed_by: args.confirmedBy, confirmed_at: now, started_at: startedAt, finished_at: now, attempts: sql<number>`attempts + 1`,
      }).where("id", "=", args.ledgerId).execute();
      return { ledgerId: args.ledgerId };
    });
  } catch (error) {
    if (error instanceof SchemaEngineError) throw error;
    const ref = randomUUID();
    console.error("[schema-engine] destructive stage failed", { ledgerId: args.ledgerId, ref }, error);
    await db.updateTable("schema_migration_ledger").set({ error_ref: ref, attempts: sql<number>`attempts + 1` })
      .where("id", "=", args.ledgerId).execute().catch(() => undefined);
    throw new SchemaEngineError("apply_failed", `The deletion could not be applied and nothing was changed. Reference: ${ref}`);
  }
}
