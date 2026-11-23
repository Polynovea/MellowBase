// Loading a model's table state, preparing plans, and the reference executor with every gate the
// runner must keep:
// - a stage runs only if the table is still at the shape hash it was planned from;
// - destructive steps never run with the expand stage: applying a plan with destructive steps leaves a
//   ledger row awaiting confirmation, and only a later call that types the model's api key runs them;
// - dropping a field deletes its permission rows and reserves its name for 30 days in the same
//   transaction as the DDL (Directus GHSA-9x5g-62gj-wqf2).
//
// applyExpandStage/applyDestructiveStage run DDL, so they need an owner-role connection (the migration
// worker's pool, never the request's). The migration runner (phase 3 wave 2) adds lock_timeout
// retries, CONCURRENTLY indexes and expand-and-contract renames around the same gates.
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { countDestructiveImpact } from "@/lib/schema/engine/impact";
import { hashShape } from "@/lib/schema/engine/hash";
import { DEFAULT_SCHEMA_LIMITS, type SchemaLimits } from "@/lib/schema/engine/limits";
import { tableNameCandidates } from "@/lib/schema/engine/names";
import type { MigrationPlan, PlanResult, PlanStage, PlanStep, TableShape } from "@/lib/schema/engine/plan";
import { applyStepToShape, buildMigrationPlan, recomputePlanHash, type FieldRename } from "@/lib/schema/engine/planner";
import { renderStep } from "@/lib/schema/engine/render";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

type Executor = Kysely<DB> | Transaction<DB>;

export const NAME_RESERVATION_DAYS = 30;
/** Per-statement lock wait in the reference executor; the runner retries with backoff on top. */
export const DDL_LOCK_TIMEOUT = "3s";

export type SchemaEngineErrorCode =
  | "not_found" | "stale_plan" | "invalid_plan" | "confirmation_mismatch" | "stage_not_ready" | "reserved_name" | "cap_exceeded" | "apply_failed";

const STATUS: Record<SchemaEngineErrorCode, number> = {
  not_found: 404, stale_plan: 409, invalid_plan: 400, confirmation_mismatch: 400, stage_not_ready: 409, reserved_name: 409, cap_exceeded: 409, apply_failed: 500,
};

/** A refusal with a plain-words message that is safe to show (it carries a 4xx status). */
export class SchemaEngineError extends Error {
  readonly status: number;
  constructor(readonly code: SchemaEngineErrorCode, message: string) {
    super(message);
    this.name = "SchemaEngineError";
    this.status = STATUS[code];
  }
}

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

function assertPlanIntegrity(plan: MigrationPlan): void {
  if (plan?.formatVersion !== 1 || !Array.isArray(plan.steps)) throw new SchemaEngineError("invalid_plan", "This change plan is in a format this version does not understand.");
  if (recomputePlanHash(plan) !== plan.planHash) throw new SchemaEngineError("invalid_plan", "This change plan was altered after it was made. Review the change again.");
  if (plan.steps.some((step) => step.table !== plan.table)) throw new SchemaEngineError("invalid_plan", "This change plan touches another model's table.");
}

async function lockModel(trx: Transaction<DB>, plan: MigrationPlan) {
  const model = await trx.selectFrom("content_models").select(["id", "workspace_id", "api_key"]).where("id", "=", plan.modelId).forUpdate().executeTakeFirst();
  if (!model || model.workspace_id !== plan.workspaceId || model.api_key !== plan.modelApiKey) {
    throw new SchemaEngineError("not_found", "This model no longer exists.");
  }
  const state = await trx.selectFrom("content_model_tables").selectAll().where("content_model_id", "=", plan.modelId).forUpdate().executeTakeFirst();
  if (state && state.table_name !== plan.table) throw new SchemaEngineError("invalid_plan", "This change plan is for a different table.");
  return state ?? null;
}

/** Runs each step's SQL and then its metadata changes, in order, inside the caller's transaction. */
async function runSteps(trx: Transaction<DB>, steps: PlanStep[], afterStep: (step: PlanStep) => Promise<void>): Promise<void> {
  await sql`select set_config('lock_timeout', ${DDL_LOCK_TIMEOUT}, true)`.execute(trx);
  for (const step of steps) {
    for (const statement of renderStep(step)) await statement.sql.execute(trx);
    await afterStep(step);
  }
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

function shapeAfter(shape: TableShape | null, steps: PlanStep[]): TableShape | null {
  return steps.reduce<TableShape | null>((current, step) => applyStepToShape(current, step), shape);
}

async function recordFailure(db: Kysely<DB>, plan: MigrationPlan, stage: PlanStage, actor: string | null, startedAt: Date, error: unknown): Promise<string> {
  const ref = randomUUID();
  console.error(`[schema-engine] ${stage} stage failed for model ${plan.modelId} (ref ${ref})`, error);
  try {
    await db.insertInto("schema_migration_ledger").values({
      workspace_id: plan.workspaceId, content_model_id: plan.modelId, model_api_key: plan.modelApiKey, table_name: plan.table,
      stage, status: "failed", plan_hash: plan.planHash, base_shape_hash: stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash,
      target_schema_hash: plan.targetSchemaHash, plan_json: JSON.stringify(plan), requested_by: actor, error_ref: ref,
      started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), attempts: 1,
    }).execute();
  } catch (ledgerError) {
    console.error(`[schema-engine] could not record failure ${ref}`, ledgerError);
  }
  return ref;
}

export interface ExpandResult {
  ledgerId: string;
  /** The ledger row of the destructive stage, waiting for the typed model name; null if there is none. */
  awaitingConfirmationId: string | null;
}

/**
 * Runs the plan's expand stage in one transaction and records it; queues the destructive stage (if
 * any) as awaiting confirmation. Needs an owner-role connection.
 */
export async function applyExpandStage(
  db: Kysely<DB>,
  args: { plan: MigrationPlan; requestedBy: string | null; limits?: SchemaLimits },
): Promise<ExpandResult> {
  const { plan, requestedBy } = args;
  assertPlanIntegrity(plan);
  const limits = args.limits ?? DEFAULT_SCHEMA_LIMITS;
  const steps = plan.steps.filter((step) => step.stage === "expand");
  const startedAt = new Date();
  try {
    return await db.transaction().execute(async (trx) => {
      const state = await lockModel(trx, plan);
      if ((state?.applied_shape_hash ?? hashShape(null)) !== plan.baseShapeHash) {
        throw new SchemaEngineError("stale_plan", "The model changed after this plan was made. Review the change again.");
      }
      if (!state && steps.some((step) => step.kind === "create_table") && (await countModelTables(trx, plan.modelId)) >= limits.maxModels) {
        throw new SchemaEngineError("cap_exceeded", `This install already has ${limits.maxModels} models, the most allowed.`);
      }
      const reserved = await loadReservedNames(trx, plan.workspaceId, plan.modelId);
      const clash = steps.flatMap((step) => {
        if (step.kind === "rename_column") return reserved.fields.has(step.to) ? [step.to] : [];
        const added = step.kind === "add_column" ? [step.column.name] : step.kind === "create_table" ? step.columns.map((c) => c.name) : [];
        return added.filter((name) => reserved.fields.has(name) || reserved.renamedFields.has(name));
      })[0];
      if (clash) throw new SchemaEngineError("reserved_name", `The field key "${clash}" was deleted or renamed in the last 30 days and cannot be reused yet.`);

      await runSteps(trx, steps, async (step) => {
        if (step.kind === "rename_column") {
          await trx.updateTable("content_field_permissions").set({ field_key: step.to, updated_at: sql<string>`now()` })
            .where("content_model_id", "=", plan.modelId).where("field_key", "=", step.from).execute();
          // Renaming back releases the name's own rename reservation.
          await trx.deleteFrom("schema_name_reservations").where("content_model_id", "=", plan.modelId).where("kind", "=", "field")
            .where("name", "=", step.to).where("reason", "=", "renamed").execute();
          await reserveName(trx, plan, "field", step.from, "renamed");
        } else if (step.kind === "drop_field_metadata") {
          await deleteFieldPermissions(trx, plan, step.field);
          await reserveName(trx, plan, "field", step.field, "deleted");
        }
      });

      const expanded = shapeAfter(plan.baseShape, steps);
      if (hashShape(expanded) !== plan.expandedShapeHash) throw new SchemaEngineError("invalid_plan", "This change plan does not add up. Review the change again.");
      if (expanded && state) {
        await trx.updateTable("content_model_tables")
          .set({ applied_shape: JSON.stringify(expanded), applied_shape_hash: plan.expandedShapeHash, updated_at: sql<string>`now()` })
          .where("content_model_id", "=", plan.modelId).execute();
      } else if (expanded) {
        await trx.insertInto("content_model_tables").values({
          content_model_id: plan.modelId, workspace_id: plan.workspaceId, table_name: plan.table,
          applied_shape: JSON.stringify(expanded), applied_shape_hash: plan.expandedShapeHash,
        }).execute();
      }

      const common = {
        workspace_id: plan.workspaceId, content_model_id: plan.modelId, model_api_key: plan.modelApiKey, table_name: plan.table,
        plan_hash: plan.planHash, target_schema_hash: plan.targetSchemaHash, plan_json: JSON.stringify(plan), requested_by: requestedBy,
      };
      const ledger = await trx.insertInto("schema_migration_ledger").values({
        ...common, stage: "expand", status: "succeeded", base_shape_hash: plan.baseShapeHash, attempts: 1,
        started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
      }).returning("id").executeTakeFirstOrThrow();

      // Any destructive stage queued by an earlier plan no longer matches this table.
      await trx.updateTable("schema_migration_ledger").set({ status: "superseded", finished_at: new Date().toISOString() })
        .where("content_model_id", "=", plan.modelId).where("status", "=", "awaiting_confirmation").execute();
      let awaitingConfirmationId: string | null = null;
      if (plan.steps.some((step) => step.stage === "destructive")) {
        const awaiting = await trx.insertInto("schema_migration_ledger").values({
          ...common, stage: "destructive", status: "awaiting_confirmation", base_shape_hash: plan.expandedShapeHash,
        }).returning("id").executeTakeFirstOrThrow();
        awaitingConfirmationId = awaiting.id;
      }
      return { ledgerId: ledger.id, awaitingConfirmationId };
    });
  } catch (error) {
    if (error instanceof SchemaEngineError) throw error;
    const ref = await recordFailure(db, plan, "expand", requestedBy, startedAt, error);
    throw new SchemaEngineError("apply_failed", `The change could not be applied and nothing was changed. Reference: ${ref}`);
  }
}

/**
 * Runs a destructive stage queued by applyExpandStage, once the user has typed the model's api key.
 * Needs an owner-role connection.
 */
export async function applyDestructiveStage(
  db: Kysely<DB>,
  args: { ledgerId: string; confirmation: string; confirmedBy: string | null },
): Promise<{ ledgerId: string }> {
  const startedAt = new Date();
  const row = await db.selectFrom("schema_migration_ledger").selectAll().where("id", "=", args.ledgerId).executeTakeFirst();
  if (!row || row.stage !== "destructive") throw new SchemaEngineError("not_found", "There is no pending deletion with this reference.");
  const plan = row.plan_json as unknown as MigrationPlan;
  assertPlanIntegrity(plan);
  if (plan.planHash !== row.plan_hash) throw new SchemaEngineError("invalid_plan", "This change plan was altered after it was made. Review the change again.");
  const steps = plan.steps.filter((step) => step.stage === "destructive");

  try {
    return await db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom("schema_migration_ledger").select(["status"]).where("id", "=", args.ledgerId).forUpdate().executeTakeFirstOrThrow();
      if (locked.status !== "awaiting_confirmation") {
        throw new SchemaEngineError("stage_not_ready", locked.status === "superseded"
          ? "The model changed after this deletion was planned. Review the change again."
          : "This deletion is not waiting for confirmation.");
      }
      if (typeof args.confirmation !== "string" || args.confirmation.trim() !== plan.modelApiKey) {
        throw new SchemaEngineError("confirmation_mismatch", `Type the model's API key, ${plan.modelApiKey}, to confirm the deletion.`);
      }
      const state = await lockModel(trx, plan);
      if (!state || state.applied_shape_hash !== plan.expandedShapeHash) {
        throw new SchemaEngineError("stale_plan", "The model changed after this deletion was planned. Review the change again.");
      }

      await runSteps(trx, steps, async (step) => {
        if (step.kind === "drop_column") {
          await deleteFieldPermissions(trx, plan, step.column);
          await reserveName(trx, plan, "field", step.column, "deleted");
        } else if (step.kind === "drop_table") {
          await deleteFieldPermissions(trx, plan);
          await reserveName(trx, plan, "model", plan.modelApiKey, "deleted");
        }
      });

      const finalShape = shapeAfter(plan.expandedShape, steps);
      if (hashShape(finalShape) !== plan.targetShapeHash) throw new SchemaEngineError("invalid_plan", "This change plan does not add up. Review the change again.");
      if (finalShape) {
        await trx.updateTable("content_model_tables")
          .set({ applied_shape: JSON.stringify(finalShape), applied_shape_hash: plan.targetShapeHash, updated_at: sql<string>`now()` })
          .where("content_model_id", "=", plan.modelId).execute();
      } else {
        await trx.deleteFrom("content_model_tables").where("content_model_id", "=", plan.modelId).execute();
      }

      const now = new Date().toISOString();
      await trx.updateTable("schema_migration_ledger").set({
        status: "succeeded", confirmed_by: args.confirmedBy, confirmed_at: now, started_at: startedAt.toISOString(), finished_at: now,
        attempts: sql<number>`attempts + 1`,
      }).where("id", "=", args.ledgerId).execute();
      return { ledgerId: args.ledgerId };
    });
  } catch (error) {
    if (error instanceof SchemaEngineError) throw error;
    const ref = randomUUID();
    console.error(`[schema-engine] destructive stage failed for model ${plan.modelId} (ref ${ref})`, error);
    await db.updateTable("schema_migration_ledger").set({ error_ref: ref, attempts: sql<number>`attempts + 1` })
      .where("id", "=", args.ledgerId).execute().catch(() => undefined);
    throw new SchemaEngineError("apply_failed", `The deletion could not be applied and nothing was changed. Reference: ${ref}`);
  }
}
