// Supabase path of the operational plan simulation and execution reads and writes (queries moved
// unchanged from planningService.ts; deleted with the switch at the end of phase 1). The simulation
// gates, the execution DAG, node executors and the proof package stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ExecutionCompletion = {
  workspaceId: string; executionId: string; planId: string; completedAt: string;
  executionPatch: Record<string, unknown>; planStatus: string; approvalRequestId: string | null; markApprovalExecuted: boolean;
  evidenceRowFor: (completed: any) => Record<string, unknown>;
  eventRowFor: (completed: any) => Record<string, unknown>;
};

/** The plan's approved, change_execute approval requests in the environment, latest review first (at most 5). */
export async function approvedRequests(workspaceId: string, environmentId: string, planId: string, requestId?: string | null): Promise<Array<{ id: string; status: string; expires_at: string | null; reviewed_at: string | null }>> {
  let query = createServiceRoleClient().from("infrastructure_approval_requests").select("id,status,expires_at,reviewed_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("operation", "change_execute").eq("entity_id", planId).eq("status", "approved");
  if (requestId) query = query.eq("id", requestId);
  const { data, error } = await query.order("reviewed_at", { ascending: false }).limit(5);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function latestSucceededDiscovery(workspaceId: string, environmentId: string): Promise<{ id: string; started_at: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("operational_discovery_runs").select("id,started_at,status").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("status", "succeeded").order("started_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

export async function assessmentInEnvironment(workspaceId: string, environmentId: string, assessmentId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("operational_change_assessments").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", assessmentId).maybeSingle();
  return data ?? null;
}

/** Records a simulation and moves its plan to the given review status. */
export async function recordSimulation(row: Record<string, unknown> & { workspace_id: string; plan_id: string }, planStatus: string): Promise<any> {
  const db = createServiceRoleClient();
  const { data: simulation, error } = await db.from("operational_simulation_runs").insert(row).select().single();
  if (error || !simulation) throw new Error(error?.message || "Could not persist operational simulation");
  await db.from("operational_change_plans").update({ status: planStatus, reviewed_at: new Date().toISOString() }).eq("id", row.plan_id);
  return simulation;
}

export async function recordBlockedExecution(row: Record<string, unknown>): Promise<any> {
  const { data: blocked, error } = await createServiceRoleClient().from("operational_execution_runs").insert(row).select().single();
  if (error || !blocked) throw new Error(error?.message || "Could not record blocked execution");
  return blocked;
}

/** Starts an execution: the run, the plan marked executing and one pending run per node. */
export async function startExecution(row: Record<string, unknown> & { workspace_id: string; plan_id: string }, pendingRowsFor: (executionId: string) => Array<Record<string, unknown>>): Promise<any> {
  const db = createServiceRoleClient();
  const { data: execution, error } = await db.from("operational_execution_runs").insert(row).select().single();
  if (error || !execution) throw new Error(error?.message || "Could not start operational execution");
  await db.from("operational_change_plans").update({ status: "executing" }).eq("id", row.plan_id);
  const { error: pendingError } = await db.from("operational_execution_node_runs").insert(pendingRowsFor(execution.id));
  if (pendingError) throw new Error(pendingError.message);
  return execution;
}

/** Updates one node's run in an execution of the workspace (only while pending when `onlyPending`). */
export async function updateNodeRun(workspaceId: string, executionId: string, planNodeId: string, patch: Record<string, unknown>, onlyPending = false): Promise<void> {
  void workspaceId; // the caller started the execution in the workspace
  let query = createServiceRoleClient().from("operational_execution_node_runs").update(patch).eq("execution_run_id", executionId).eq("plan_node_id", planNodeId);
  if (onlyPending) query = query.eq("status", "pending");
  await query;
}

/**
 * Completes an execution: the run's result, the plan's final status, the approval request marked
 * executed, the proof package and the operational event. Returns the run and the package.
 */
export async function completeExecution(input: ExecutionCompletion): Promise<{ completed: any; evidencePackage: any }> {
  const db = createServiceRoleClient();
  const { data: completed, error: completeError } = await db.from("operational_execution_runs").update(input.executionPatch).eq("id", input.executionId).select().single();
  if (completeError || !completed) throw new Error(completeError?.message || "Could not finalize operational execution");
  await db.from("operational_change_plans").update({ status: input.planStatus }).eq("id", input.planId);
  if (input.approvalRequestId && input.markApprovalExecuted) await db.from("infrastructure_approval_requests").update({ status: "executed", executed_at: input.completedAt, updated_at: input.completedAt }).eq("workspace_id", input.workspaceId).eq("id", input.approvalRequestId).eq("status", "approved");
  const { data: evidencePackage, error: evidenceError } = await db.from("operational_evidence_packages").insert(input.evidenceRowFor(completed)).select().single();
  if (evidenceError || !evidencePackage) throw new Error(evidenceError?.message || "Could not persist proof package");
  await db.from("operational_events").insert(input.eventRowFor(completed));
  return { completed, evidencePackage };
}

export async function auditExecution(payload: PlatformAuditPayload): Promise<void> {
  await logPlatformEvent(payload);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
