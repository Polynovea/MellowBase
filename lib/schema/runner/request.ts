// The request side of a schema change: runs as the app role. It may only INSERT a ledger row (the
// request's own columns; a trigger sets its status from the stage), confirm a deletion and retry a
// failed stage through two owner-side functions, and read the outcome. The migration worker
// (polynovea_owner, its own process and pool) rebuilds the plan from trusted state and applies it.
import { sql, type Kysely } from "kysely";
import type { DbExecutor } from "@/lib/db";
import type { DB } from "@/lib/db/generated/database";
import type { SchemaLimits } from "@/lib/schema/engine/limits";
import type { MigrationPlan, PlanStage } from "@/lib/schema/engine/plan";
import { computeStageHash } from "@/lib/schema/engine/planner";
import { buildPlanFromTrustedState } from "@/lib/schema/engine/trusted";

export interface PlanStageRequest {
  plan: MigrationPlan;
  stage: PlanStage;
  /** admin_users.id of whoever asked. */
  requestedBy: string | null;
  /** The content_model_versions row the change is for (the worker rebuilds the plan from it). */
  targetVersionId?: string | null;
  /** Field renames the user asked for (a version cannot express them). Stored on the expand row only. */
  renames?: Array<{ from: string; to: string }>;
}

/**
 * Plans a change from trusted state (the model's table, the target version, the renames; read-only
 * access is enough) and queues it: an expand row if the plan has expand steps (pending at once), a
 * destructive row if it has destructive steps (awaiting_confirmation until confirmPlanStage). Each
 * row's plan_hash is computeStageHash of the full plan for its stage; the worker rebuilds that stage
 * and runs it only if it hashes the same.
 */
export async function requestSchemaChange(
  db: DbExecutor,
  input: { contentModelId: string; targetVersionId: string | null; renames?: Array<{ from: string; to: string }>; requestedBy: string | null; limits?: SchemaLimits },
): Promise<{ plan: MigrationPlan; expandLedgerId: string | null; destructiveLedgerId: string | null }> {
  const plan = await buildPlanFromTrustedState(db, {
    contentModelId: input.contentModelId, targetVersionId: input.targetVersionId, renames: input.renames ?? [], stage: "expand", limits: input.limits,
  });
  const base = { plan, requestedBy: input.requestedBy, targetVersionId: input.targetVersionId };
  const hasStage = (stage: PlanStage) => plan.steps.some((step) => step.stage === stage);
  // One transaction: the request's rows share created_at, so the supersede trigger replaces the model's
  // older requests and never this request's own other row.
  const queue = async (trx: DbExecutor) => {
    const expand = hasStage("expand") ? await requestPlanStage(trx, { ...base, stage: "expand", renames: input.renames ?? [] }) : null;
    const destructive = hasStage("destructive") ? await requestPlanStage(trx, { ...base, stage: "destructive" }) : null;
    return { plan, expandLedgerId: expand?.ledgerId ?? null, destructiveLedgerId: destructive?.ledgerId ?? null };
  };
  return db.isTransaction ? queue(db) : (db as Kysely<DB>).transaction().execute(queue);
}

/**
 * Queues one stage of an already planned change (requestSchemaChange does both). Its plan_hash is
 * computeStageHash(plan, stage). The expand stage is pending at once; a destructive stage waits as
 * awaiting_confirmation until confirmPlanStage. Renames go on the expand row only.
 */
export async function requestPlanStage(db: DbExecutor, request: PlanStageRequest): Promise<{ ledgerId: string; status: string }> {
  const { plan, stage } = request;
  const baseShapeHash = stage === "expand" ? plan.baseShapeHash : plan.expandedShapeHash;
  const { rows: [row] } = await sql<{ id: string; status: string }>`
    insert into public.schema_migration_ledger
      (workspace_id, content_model_id, model_api_key, table_name, stage, plan_hash, base_shape_hash, target_schema_hash, plan_json, requested_by,
       target_version_id, renames)
    values (${plan.workspaceId}, ${plan.modelId}, ${plan.modelApiKey}, ${plan.table}, ${stage}, ${computeStageHash(plan, stage)},
            ${baseShapeHash}, ${plan.targetSchemaHash}, ${JSON.stringify(plan)}::jsonb, ${request.requestedBy}, ${request.targetVersionId ?? null},
            ${JSON.stringify(stage === "expand" ? request.renames ?? [] : [])}::jsonb)
    returning id, status`.execute(db);
  return { ledgerId: row.id, status: row.status };
}

/**
 * Confirms a destructive stage: `typedApiKey` must be the model's api key. `confirmedBy` must be the
 * signed-in admin: the database checks it is an active member of the workspace but cannot prove who
 * is at the keyboard, so the audit trail is as trustworthy as the caller's session handling. Throws (SQLSTATE 22023
 * schema_confirmation_mismatch, 55000 not waiting, P0002 not found) otherwise.
 */
export async function confirmPlanStage(db: DbExecutor, input: { ledgerId: string; confirmedBy: string | null; typedApiKey: string }): Promise<void> {
  await sql`select public.polynovea_confirm_schema_stage(${input.ledgerId}::uuid, ${input.confirmedBy}::uuid, ${input.typedApiKey})`.execute(db);
}

/**
 * Cancels a request that has not started (pending or awaiting confirmation). Throws (SQLSTATE 55000
 * schema_stage_not_cancellable, 22023 schema_cancel_unknown_user, P0002 not found) otherwise.
 */
export async function cancelPlanStage(db: DbExecutor, input: { ledgerId: string; cancelledBy: string }): Promise<void> {
  await sql`select public.polynovea_cancel_schema_stage(${input.ledgerId}::uuid, ${input.cancelledBy}::uuid)`.execute(db);
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
