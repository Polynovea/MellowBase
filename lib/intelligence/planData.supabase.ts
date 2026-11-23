// Supabase path of the autonomy policy and operational plan reads and writes (queries moved
// unchanged from planningService.ts; deleted with the switch at the end of phase 1). Plan
// derivation, classification and the policy rules stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type PlanPersist = {
  planRow: Record<string, unknown> & { workspace_id: string; environment_id: string; desired_state_revision_id: string };
  nodeRowsFor: (planId: string) => Array<Record<string, unknown>>;
  edgeRowsFor: (planId: string, idByKey: Map<string, string>) => Array<Record<string, unknown>>;
  markDriftPlanned: boolean;
  auditFor: (plan: any) => PlatformAuditPayload;
};

/** The environment's autonomy policy, created in diagnose-only mode when there is none. */
export async function autonomyPolicy(workspaceId: string, environmentId: string): Promise<any> {
  const db = createServiceRoleClient();
  const { data: existing, error } = await db.from("operational_autonomy_policies").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing;
  const { data: created, error: createError } = await db.from("operational_autonomy_policies").insert({ workspace_id: workspaceId, environment_id: environmentId, mode: "diagnose_only" }).select().single();
  if (createError || !created) throw new Error(createError?.message || "Could not create operational autonomy policy");
  return created;
}

export async function saveAutonomyPolicy(row: Record<string, unknown>, auditFor: (policy: any) => PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("operational_autonomy_policies").upsert(row, { onConflict: "environment_id" }).select().single();
  if (error || !data) throw new Error(error?.message || "Could not update autonomy policy");
  await logPlatformEvent(auditFor(data));
  return data;
}

/** Whether the reconciliation run belongs to the workspace's environment. */
export async function reconciliationRunInEnvironment(workspaceId: string, environmentId: string, runId: string): Promise<boolean> {
  const { data } = await createServiceRoleClient().from("operational_reconciliation_runs").select("id").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", runId).maybeSingle();
  return Boolean(data);
}

/** The desired state's unresolved drift and the environment's world nodes, for planning. */
export async function planInputs(workspaceId: string, environmentId: string, revisionId: string): Promise<{ drifts: any[]; worldNodes: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: drifts, error: driftError }, { data: worldNodes, error: nodesError }] = await Promise.all([
    db.from("operational_drift_items").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("desired_state_revision_id", revisionId).in("state", ["open", "acknowledged", "planned"]).order("severity"),
    db.from("operational_world_nodes").select("id,node_key,source_entity_type,source_entity_id,state,provider,attributes_json").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
  ]);
  if (driftError) throw new Error(driftError.message);
  if (nodesError) throw new Error(nodesError.message);
  return { drifts: drifts ?? [], worldNodes: worldNodes ?? [] };
}

export async function planByChecksum(workspaceId: string, environmentId: string, checksum: string): Promise<any | null> {
  const { data: existing, error } = await createServiceRoleClient().from("operational_change_plans").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("plan_checksum_sha256", checksum).maybeSingle();
  if (error) throw new Error(error.message);
  return existing ?? null;
}

/** Persists a plan with its nodes and edges, marks its drift planned and writes the audit event. */
export async function persistPlan(input: PlanPersist): Promise<any> {
  const db = createServiceRoleClient();
  const { data: plan, error: planError } = await db.from("operational_change_plans").insert(input.planRow).select().single();
  if (planError || !plan) throw new Error(planError?.message || "Could not persist operational plan");
  const { data: persistedNodes, error: persistedNodesError } = await db.from("operational_change_plan_nodes").insert(input.nodeRowsFor(plan.id)).select("id,node_key");
  if (persistedNodesError) throw new Error(persistedNodesError.message);
  const idByKey = new Map((persistedNodes ?? []).map((node) => [node.node_key, node.id]));
  const edgeRows = input.edgeRowsFor(plan.id, idByKey);
  if (edgeRows.length) {
    const { error } = await db.from("operational_change_plan_edges").insert(edgeRows);
    if (error) throw new Error(error.message);
  }
  if (input.markDriftPlanned) await db.from("operational_drift_items").update({ state: "planned" }).eq("workspace_id", input.planRow.workspace_id).eq("environment_id", input.planRow.environment_id).eq("desired_state_revision_id", input.planRow.desired_state_revision_id).in("state", ["open", "acknowledged"]);
  await logPlatformEvent(input.auditFor(plan));
  return plan;
}

/** A plan of the workspace with its nodes (in order) and edges. */
export async function planGraph(workspaceId: string, planId: string): Promise<{ plan: any | null; nodes: any[]; edges: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: plan, error: planError }, { data: nodes, error: nodesError }, { data: edges, error: edgesError }] = await Promise.all([
    db.from("operational_change_plans").select("*").eq("workspace_id", workspaceId).eq("id", planId).maybeSingle(),
    db.from("operational_change_plan_nodes").select("*").eq("plan_id", planId).order("ordinal"),
    db.from("operational_change_plan_edges").select("*").eq("plan_id", planId),
  ]);
  if (planError) throw new Error(planError.message);
  if (nodesError) throw new Error(nodesError.message);
  if (edgesError) throw new Error(edgesError.message);
  return { plan: plan ?? null, nodes: plan ? nodes ?? [] : [], edges: plan ? edges ?? [] : [] };
}

export async function planLists(workspaceId: string, environmentId: string): Promise<{ plans: any[]; simulations: any[]; executions: any[]; evidencePackages: any[] }> {
  const db = createServiceRoleClient();
  const [plans, simulations, executions, evidence] = await Promise.all([
    db.from("operational_change_plans").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("created_at", { ascending: false }).limit(50),
    db.from("operational_simulation_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("started_at", { ascending: false }).limit(50),
    db.from("operational_execution_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("started_at", { ascending: false }).limit(50),
    db.from("operational_evidence_packages").select("id,execution_run_id,plan_id,checksum_sha256,created_at,package_json").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("created_at", { ascending: false }).limit(50),
  ]);
  return { plans: plans.data ?? [], simulations: simulations.data ?? [], executions: executions.data ?? [], evidencePackages: evidence.data ?? [] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
