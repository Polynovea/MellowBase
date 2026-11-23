// The plan the migration worker runs is never one it was handed. polynovea_app can write ledger rows,
// and a plan hash is a plain SHA-256 anyone can recompute, so a stored plan proves nothing. Instead
// the worker rebuilds the plan from state the app cannot forge:
//   - content_model_tables (the table, its recorded shape and applied version; read-only for the app
//     after 0074),
//   - the target content_model_versions row, which must belong to the model,
//   - the model row (workspace, api key; deleting a table requires the model to be archived),
// plus the requested renames, which are re-validated against both schemas (the field being renamed
// must exist in the table, the new key must be a new stored field of the target, same kind of value).
// The request side builds its plan with the same function (read-only access is enough), so an honest
// request hashes the same on both sides; assertRequestedPlan refuses anything else.
import type { Kysely, Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import { DEFAULT_SCHEMA_LIMITS, type SchemaLimits } from "@/lib/schema/engine/limits";
import type { MigrationPlan, PlanStage } from "@/lib/schema/engine/plan";
import { buildMigrationPlan, computePlanHash, type FieldRename } from "@/lib/schema/engine/planner";
import { chooseTableName, loadModelTable, loadReservedNames } from "@/lib/schema/engine/apply";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

type Executor = Kysely<DB> | Transaction<DB>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TrustedPlanInput {
  contentModelId: string;
  /** The saved version to build toward; null deletes the model's table (the model must be archived). */
  targetVersionId: string | null;
  /**
   * Renames requested for this change. Carried as data (e.g. in the ledger row) and re-validated here
   * against the table and the target version, so a forged rename can do no more than an honest one.
   */
  renames?: FieldRename[];
  /** "expand" plans the whole change; "destructive" requires the expand stage to have run already. */
  stage: PlanStage;
  limits?: SchemaLimits;
}

async function loadVersion(db: Executor, contentModelId: string, versionId: string): Promise<CanonicalSchema> {
  if (!UUID.test(versionId)) throw new SchemaEngineError("not_found", "This schema version does not exist for this model.");
  const row = await db.selectFrom("content_model_versions").select(["content_model_id", "schema_json"]).where("id", "=", versionId).executeTakeFirst();
  if (!row || row.content_model_id !== contentModelId) throw new SchemaEngineError("not_found", "This schema version does not exist for this model.");
  return row.schema_json as unknown as CanonicalSchema;
}

/** Rebuilds the plan for a change from trusted state. Deterministic: same state, same plan hash. */
export async function buildPlanFromTrustedState(db: Executor, input: TrustedPlanInput): Promise<MigrationPlan> {
  if (!UUID.test(String(input.contentModelId))) throw new SchemaEngineError("not_found", "This model no longer exists.");
  const model = await db.selectFrom("content_models").select(["id", "workspace_id", "api_key", "status"]).where("id", "=", input.contentModelId).executeTakeFirst();
  if (!model) throw new SchemaEngineError("not_found", "This model no longer exists.");
  if (input.targetVersionId === null && model.status !== "archived") {
    throw new SchemaEngineError("invalid_plan", "A model's table can only be deleted after the model is archived.");
  }
  const renames = Array.isArray(input.renames) ? input.renames.map((r) => ({ from: String(r?.from), to: String(r?.to) })) : [];
  if (input.targetVersionId === null && renames.length) throw new SchemaEngineError("invalid_plan", "Deleting a model cannot rename fields.");

  const state = await loadModelTable(db, model.id);
  const target = input.targetVersionId === null ? null : await loadVersion(db, model.id, input.targetVersionId);
  const current = state?.appliedVersionId ? await loadVersion(db, model.id, state.appliedVersionId) : null;
  const table = state?.table ?? (await chooseTableName(db, model.workspace_id, model.api_key));
  const reserved = await loadReservedNames(db, model.workspace_id, model.id);
  const others = await db.selectFrom("content_model_tables").select((eb) => eb.fn.countAll<string>().as("n")).where("content_model_id", "<>", model.id).executeTakeFirst();

  const result = buildMigrationPlan({
    workspaceId: model.workspace_id,
    modelId: model.id,
    modelApiKey: model.api_key,
    table,
    currentShape: state?.shape ?? null,
    currentSchema: current,
    targetSchema: target,
    targetVersionId: input.targetVersionId,
    renames,
    limits: input.limits ?? DEFAULT_SCHEMA_LIMITS,
    otherModelCount: Number(others?.n ?? 0),
    reservedFieldNames: reserved.fields,
    renamedFieldNames: reserved.renamedFields,
    reservedModelNames: reserved.models,
  });
  if (!result.ok) throw new SchemaEngineError(result.problems[0].code === "cap_exceeded" ? "cap_exceeded" : "invalid_plan", result.problems.map((p) => p.message).join(" "));
  if (input.stage === "destructive" && result.plan.steps.some((step) => step.stage === "expand")) {
    throw new SchemaEngineError("stage_not_ready", "The first part of this change has not been applied yet.");
  }
  return result.plan;
}

/**
 * The worker's check: rebuild the plan from trusted state and refuse unless it hashes exactly as the
 * request said. Returns the rebuilt plan, which is the only plan the worker may execute.
 */
export async function assertRequestedPlan(db: Executor, input: TrustedPlanInput & { requestedPlanHash: string }): Promise<MigrationPlan> {
  const plan = await buildPlanFromTrustedState(db, input);
  if (computePlanHash(plan) !== plan.planHash || plan.planHash !== input.requestedPlanHash) {
    throw new SchemaEngineError("stale_plan", "This change no longer matches the model. Review the change again.");
  }
  return plan;
}
