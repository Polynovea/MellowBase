// The request side of a schema change: runs as the app role. It may only INSERT a ledger row (the
// request's own columns; a trigger sets its status from the stage), confirm a deletion and retry a
// failed stage through two owner-side functions, and read the outcome. The migration worker
// (polynovea_owner, its own process and pool) rebuilds the plan from trusted state and applies it.
import { sql } from "kysely";
import type { DbExecutor } from "@/lib/db";
import type { MigrationPlan, PlanStage } from "@/lib/schema/engine/plan";

export interface PlanStageRequest {
  plan: MigrationPlan;
  stage: PlanStage;
  /** admin_users.id of whoever asked. */
  requestedBy: string | null;
  /** The content_model_versions row the change is for (the worker rebuilds the plan from it). */
  targetVersionId?: string | null;
}

/**
 * Queues one stage of a plan. The expand stage is pending at once; a destructive stage waits as
 * awaiting_confirmation until confirmPlanStage.
 */
export async function requestPlanStage(db: DbExecutor, request: PlanStageRequest): Promise<{ ledgerId: string; status: string }> {
  const { plan, stage } = request;
  const baseShapeHash = stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash;
  const { rows: [row] } = await sql<{ id: string; status: string }>`
    insert into public.schema_migration_ledger
      (workspace_id, content_model_id, model_api_key, table_name, stage, plan_hash, base_shape_hash, target_schema_hash, plan_json, requested_by, target_version_id)
    values (${plan.workspaceId}, ${plan.modelId}, ${plan.modelApiKey}, ${plan.table}, ${stage}, ${plan.planHash},
            ${baseShapeHash}, ${plan.targetSchemaHash}, ${JSON.stringify(plan)}::jsonb, ${request.requestedBy}, ${request.targetVersionId ?? null})
    returning id, status`.execute(db);
  return { ledgerId: row.id, status: row.status };
}

/**
 * Confirms a destructive stage: `typedApiKey` must be the model's api key. Throws (SQLSTATE 22023
 * schema_confirmation_mismatch, 55000 not waiting, P0002 not found) otherwise.
 */
export async function confirmPlanStage(db: DbExecutor, input: { ledgerId: string; confirmedBy: string | null; typedApiKey: string }): Promise<void> {
  await sql`select public.polynovea_confirm_schema_stage(${input.ledgerId}::uuid, ${input.confirmedBy}::uuid, ${input.typedApiKey})`.execute(db);
}

/** Puts a failed stage back in the queue; the worker resumes it where it stopped. */
export async function retryPlanStage(db: DbExecutor, ledgerId: string): Promise<void> {
  await sql`select public.polynovea_retry_schema_stage(${ledgerId}::uuid)`.execute(db);
}

/** A stage's state for the UI: the ledger row plus the worker's progress (read-only for the app). */
export async function planStageStatus(db: DbExecutor, ledgerId: string) {
  const { rows: [row] } = await sql<{
    status: string; error_ref: string | null; attempts: number; started_at: string | null; finished_at: string | null;
    next_step: number | null; step_log: unknown;
  }>`
    select l.status, l.error_ref, l.attempts, l.started_at, l.finished_at, r.next_step, r.step_log
      from public.schema_migration_ledger l
      left join public.schema_migration_runs r on r.ledger_id = l.id
     where l.id = ${ledgerId}`.execute(db);
  return row ?? null;
}
