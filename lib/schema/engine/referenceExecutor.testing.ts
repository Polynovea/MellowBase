// TEST ONLY. The reference executor the schema engine's tests use to apply plans: the same gates as
// the migration runner (assertStageCurrent, applyStageBookkeeping), every statement of a stage in one
// transaction, no retries. It trusts the plan it is given (applyDestructiveStage even reads plan_json
// from the ledger), so production code must never import it: the migration runner, which rebuilds
// every plan from trusted state (buildPlanForLedgerRequest), is the only production executor.
// engineBoundary.test.ts fails if anything but a test imports this file.
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { applyStageBookkeeping, assertStageCurrent, expectedConfirmation } from "@/lib/schema/engine/apply";
import { confirmationPrompt } from "@/lib/schema/engine/describe";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import type { SchemaLimits } from "@/lib/schema/engine/limits";
import type { MigrationPlan, PlanStage } from "@/lib/schema/engine/plan";
import { renderStep } from "@/lib/schema/engine/render";

/** Per-statement lock wait in the reference executor. */
const DDL_LOCK_TIMEOUT = "3s";

const stageSteps = (plan: MigrationPlan, stage: PlanStage) => plan.steps.filter((step) => step.stage === stage);
const stageBaseHash = (plan: MigrationPlan, stage: PlanStage) => (stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash);

/**
 * The reference executor's loop: every statement of the stage in the caller's transaction, indexes not
 * concurrent. It deliberately ignores `ownTransaction`: it is the test reference, and keeping the
 * stage and its bookkeeping atomic is what lets a failure leave nothing behind. The migration runner
 * honours `ownTransaction` (short FK adds, VALIDATE and backfill committed on their own) and records
 * progress so it can resume.
 */
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
  /** The ledger row of the destructive stage, waiting for the model's API key to be typed; null if there is none. */
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
      const expected = await expectedConfirmation(trx, row.content_model_id ?? "");
      if (typeof args.confirmation !== "string" || args.confirmation.trim() !== expected) {
        throw new SchemaEngineError("confirmation_mismatch", confirmationPrompt(expected));
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
