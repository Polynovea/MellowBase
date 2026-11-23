// PostgreSQL implementation of the operational plan simulation and execution reads and writes
// (phase 1, wave 4). Deliberate differences from the Supabase path it replaced in phase 1:
// - A simulation and its plan's review status commit together; so do an execution's start, its
// plan's executing status and the pending node runs; and the execution's completion, the plan's
// final status, the approval request, the proof package and the operational event. The Supabase
// path ran each as separate calls, so a failure could leave a plan "executing" with no node runs,
// or a completed execution with no proof package.
// - Plan and approval updates are scoped by workspace_id; node runs (which have no workspace_id)
// are only updated through an execution of the workspace.
// - Reads have id tie-breaks; jsonb values are serialized explicitly; database text never reaches
// the caller.
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ExecutionCompletion = {
  workspaceId: string; executionId: string; planId: string; completedAt: string;
  executionPatch: Record<string, unknown>; planStatus: string; approvalRequestId: string | null; markApprovalExecuted: boolean;
  evidenceRowFor: (completed: any) => Record<string, unknown>;
  eventRowFor: (completed: any) => Record<string, unknown>;
};


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));
const JSON_COLUMNS = ["approval_json", "hard_blockers_json", "result_json", "rollback_coverage_json", "side_effects_json", "warnings_json", "safe_input_json", "safe_result_json", "verification_json", "package_json", "features_json", "outcome_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;

async function guarded<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(clientErrorMessage(error, fallback));
  }
}

export async function approvedRequests(workspaceId: string, environmentId: string, planId: string, requestId?: string | null): Promise<Array<{ id: string; status: string; expires_at: string | null; reviewed_at: string | null }>> {
  if (!ids(environmentId) || (requestId && !ids(requestId))) return [];
  let query = getDb().selectFrom("infrastructure_approval_requests").select(["id", "status", "expires_at", "reviewed_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("operation", "=", "change_execute").where("entity_id", "=", planId).where("status", "=", "approved");
  if (requestId) query = query.where("id", "=", requestId);
  return query.orderBy("reviewed_at", "desc").orderBy("id").limit(5).execute();
}

export async function latestSucceededDiscovery(workspaceId: string, environmentId: string): Promise<{ id: string; started_at: string; status: string } | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("operational_discovery_runs").select(["id", "started_at", "status"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("status", "=", "succeeded").orderBy("started_at", "desc").orderBy("id").limit(1).executeTakeFirst()) ?? null;
}

export async function assessmentInEnvironment(workspaceId: string, environmentId: string, assessmentId: string): Promise<any | null> {
  if (!ids(environmentId, assessmentId)) return null;
  return (await getDb().selectFrom("operational_change_assessments").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", assessmentId).executeTakeFirst()) ?? null;
}

export async function recordSimulation(row: Record<string, unknown> & { workspace_id: string; plan_id: string }, planStatus: string): Promise<any> {
  return guarded("Could not persist operational simulation", () => withTransaction(async (trx) => {
    const simulation = await trx.insertInto("operational_simulation_runs").values(json(row)).returningAll().executeTakeFirstOrThrow();
    await trx.updateTable("operational_change_plans").set({ status: planStatus, reviewed_at: new Date().toISOString() }).where("workspace_id", "=", row.workspace_id).where("id", "=", row.plan_id).execute();
    return simulation;
  }));
}

export async function recordBlockedExecution(row: Record<string, unknown>): Promise<any> {
  return guarded("Could not record blocked execution", () => getDb().insertInto("operational_execution_runs").values(json(row)).returningAll().executeTakeFirstOrThrow());
}

export async function startExecution(row: Record<string, unknown> & { workspace_id: string; plan_id: string }, pendingRowsFor: (executionId: string) => Array<Record<string, unknown>>): Promise<any> {
  return guarded("Could not start operational execution", () => withTransaction(async (trx) => {
    const execution = await trx.insertInto("operational_execution_runs").values(json(row)).returningAll().executeTakeFirstOrThrow();
    await trx.updateTable("operational_change_plans").set({ status: "executing" }).where("workspace_id", "=", row.workspace_id).where("id", "=", row.plan_id).execute();
    const pending = pendingRowsFor(execution.id);
    if (pending.length) await trx.insertInto("operational_execution_node_runs").values(pending.map(json)).execute();
    return execution;
  }));
}

export async function updateNodeRun(workspaceId: string, executionId: string, planNodeId: string, patch: Record<string, unknown>, onlyPending = false): Promise<void> {
  let query = getDb().updateTable("operational_execution_node_runs").set(json(patch)).where("execution_run_id", "=", executionId).where("plan_node_id", "=", planNodeId)
    .where("execution_run_id", "in", (eb) => eb.selectFrom("operational_execution_runs").select("id").where("workspace_id", "=", workspaceId).where("id", "=", executionId));
  if (onlyPending) query = query.where("status", "=", "pending");
  await query.execute();
}

export async function completeExecution(input: ExecutionCompletion): Promise<{ completed: any; evidencePackage: any }> {
  return guarded("Could not finalize operational execution", () => withTransaction(async (trx) => {
    const completed = await trx.updateTable("operational_execution_runs").set(json(input.executionPatch)).where("workspace_id", "=", input.workspaceId).where("id", "=", input.executionId).returningAll().executeTakeFirst();
    if (!completed) throw new Error("Could not finalize operational execution");
    await trx.updateTable("operational_change_plans").set({ status: input.planStatus }).where("workspace_id", "=", input.workspaceId).where("id", "=", input.planId).execute();
    if (input.approvalRequestId && input.markApprovalExecuted) {
      await trx.updateTable("infrastructure_approval_requests").set({ status: "executed", executed_at: input.completedAt, updated_at: input.completedAt })
        .where("workspace_id", "=", input.workspaceId).where("id", "=", input.approvalRequestId).where("status", "=", "approved").execute();
    }
    const evidencePackage = await trx.insertInto("operational_evidence_packages").values(json(input.evidenceRowFor(completed))).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto("operational_events").values(json(input.eventRowFor(completed))).execute();
    return { completed, evidencePackage };
  }));
}

export async function auditExecution(payload: PlatformAuditPayload): Promise<void> {
  await withTransaction((trx) => recordPlatformEvent(trx, payload));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
