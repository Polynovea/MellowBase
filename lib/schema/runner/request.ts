// The request side of a schema change: runs as the app role and only writes a ledger row. The
// migration worker (polynovea_owner, its own process and pool) picks the row up, re-checks it from
// scratch and applies it. Nothing here holds or needs owner rights.
import { sql } from "kysely";
import type { DbExecutor } from "@/lib/db";
import type { MigrationPlan, PlanStage } from "@/lib/schema/engine/plan";

export interface PlanStageRequest {
  plan: MigrationPlan;
  stage: PlanStage;
  /** admin_users.id of whoever asked. */
  requestedBy: string | null;
}

/**
 * Queues one stage of a plan. The expand stage is pending at once; a destructive stage waits as
 * awaiting_confirmation until the model name is typed (the engine's confirmation gate sets
 * confirmed_by/confirmed_at and moves it to pending).
 */
export async function requestPlanStage(db: DbExecutor, request: PlanStageRequest): Promise<{ ledgerId: string; status: string }> {
  const { plan, stage } = request;
  const status = stage === "destructive" ? "awaiting_confirmation" : "pending";
  const baseShapeHash = stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash;
  const { rows: [row] } = await sql<{ id: string; status: string }>`
    insert into public.schema_migration_ledger
      (workspace_id, content_model_id, model_api_key, table_name, stage, status, plan_hash, base_shape_hash, target_schema_hash, plan_json, requested_by)
    values (${plan.workspaceId}, ${plan.modelId}, ${plan.modelApiKey}, ${plan.table}, ${stage}, ${status}, ${plan.planHash},
            ${baseShapeHash}, ${plan.targetSchemaHash}, ${JSON.stringify(plan)}::jsonb, ${request.requestedBy})
    returning id, status`.execute(db);
  return { ledgerId: row.id, status: row.status };
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
