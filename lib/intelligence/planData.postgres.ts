// Direct PostgreSQL implementation of the autonomy policy and operational plan reads and writes
// (phase 1, wave 4). Same signatures and shapes as planData.supabase.ts. Differences that are
// deliberate:
// - The autonomy policy is created with ON CONFLICT DO NOTHING (two first reads cannot fail each
//   other), and a policy save commits with its audit event; the upsert only updates the caller's
//   workspace's row.
// - A plan, its nodes and edges, marking its drift planned and the audit event commit together
//   (the Supabase path could leave a plan without nodes, which then matched by checksum forever).
// - Plan nodes and edges are read only once the plan is found in the workspace (they have no
//   workspace_id).
// - Lists keep their limits and gain an id tie-break; jsonb values are serialized explicitly;
//   database text never reaches the caller.
import { sql } from "kysely";
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { PlanPersist } from "@/lib/intelligence/planData.supabase";

export type { PlanPersist } from "@/lib/intelligence/planData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));
const JSON_COLUMNS = ["settings_json", "immutable_plan_json", "preconditions_json", "input_json", "verification_json", "compensation_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;

async function guarded<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(clientErrorMessage(error, fallback));
  }
}

export async function autonomyPolicy(workspaceId: string, environmentId: string): Promise<any> {
  return guarded("Could not create operational autonomy policy", async () => {
    const db = getDb();
    const find = () => db.selectFrom("operational_autonomy_policies").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).executeTakeFirst();
    const existing = await find();
    if (existing) return existing;
    await db.insertInto("operational_autonomy_policies").values({ workspace_id: workspaceId, environment_id: environmentId, mode: "diagnose_only" })
      .onConflict((conflict) => conflict.column("environment_id").doNothing()).execute();
    const created = await find();
    if (!created) throw new Error("Could not create operational autonomy policy");
    return created;
  });
}

export async function saveAutonomyPolicy(row: Record<string, unknown>, auditFor: (policy: any) => PlatformAuditPayload): Promise<any> {
  return guarded("Could not update autonomy policy", () => withTransaction(async (trx) => {
    const update = Object.fromEntries(Object.keys(row).filter((key) => key !== "environment_id").map((key) => [key, sql.ref(`excluded.${key}`)])) as any;
    const policy = await trx.insertInto("operational_autonomy_policies").values(json(row))
      .onConflict((conflict) => conflict.column("environment_id").doUpdateSet(update).where("operational_autonomy_policies.workspace_id", "=", row.workspace_id as string))
      .returningAll().executeTakeFirst();
    if (!policy) throw new Error("Could not update autonomy policy");
    await recordPlatformEvent(trx, auditFor(policy));
    return policy;
  }));
}

export async function reconciliationRunInEnvironment(workspaceId: string, environmentId: string, runId: string): Promise<boolean> {
  if (!ids(environmentId, runId)) return false;
  return Boolean(await getDb().selectFrom("operational_reconciliation_runs").select("id").where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", runId).executeTakeFirst());
}

export async function planInputs(workspaceId: string, environmentId: string, revisionId: string): Promise<{ drifts: any[]; worldNodes: any[] }> {
  if (!ids(environmentId, revisionId)) return { drifts: [], worldNodes: [] };
  const db = getDb();
  const [drifts, worldNodes] = await Promise.all([
    db.selectFrom("operational_drift_items").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("desired_state_revision_id", "=", revisionId)
      .where("state", "in", ["open", "acknowledged", "planned"]).orderBy("severity").orderBy("id").execute(),
    db.selectFrom("operational_world_nodes").select(["id", "node_key", "source_entity_type", "source_entity_id", "state", "provider", "attributes_json"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
  ]);
  return { drifts, worldNodes };
}

export async function planByChecksum(workspaceId: string, environmentId: string, checksum: string): Promise<any | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("operational_change_plans").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("plan_checksum_sha256", "=", checksum).executeTakeFirst()) ?? null;
}

export async function persistPlan(input: PlanPersist): Promise<any> {
  return guarded("Could not persist operational plan", () => withTransaction(async (trx) => {
    const plan = await trx.insertInto("operational_change_plans").values(json(input.planRow)).returningAll().executeTakeFirstOrThrow();
    const nodeRows = input.nodeRowsFor(plan.id);
    const nodes = nodeRows.length ? await trx.insertInto("operational_change_plan_nodes").values(nodeRows.map(json)).returning(["id", "node_key"]).execute() : [];
    const edgeRows = input.edgeRowsFor(plan.id, new Map(nodes.map((node) => [node.node_key, node.id])));
    if (edgeRows.length) await trx.insertInto("operational_change_plan_edges").values(edgeRows as any).execute();
    if (input.markDriftPlanned) {
      await trx.updateTable("operational_drift_items").set({ state: "planned" })
        .where("workspace_id", "=", input.planRow.workspace_id).where("environment_id", "=", input.planRow.environment_id).where("desired_state_revision_id", "=", input.planRow.desired_state_revision_id)
        .where("state", "in", ["open", "acknowledged"]).execute();
    }
    await recordPlatformEvent(trx, input.auditFor(plan));
    return plan;
  }));
}

export async function planGraph(workspaceId: string, planId: string): Promise<{ plan: any | null; nodes: any[]; edges: any[] }> {
  if (!ids(planId)) return { plan: null, nodes: [], edges: [] };
  const db = getDb();
  const plan = await db.selectFrom("operational_change_plans").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", planId).executeTakeFirst();
  if (!plan) return { plan: null, nodes: [], edges: [] };
  const [nodes, edges] = await Promise.all([
    db.selectFrom("operational_change_plan_nodes").selectAll().where("plan_id", "=", plan.id).orderBy("ordinal").orderBy("id").execute(),
    db.selectFrom("operational_change_plan_edges").selectAll().where("plan_id", "=", plan.id).orderBy("from_node_id").orderBy("to_node_id").orderBy("edge_kind").execute(),
  ]);
  return { plan, nodes, edges };
}

export async function planLists(workspaceId: string, environmentId: string): Promise<{ plans: any[]; simulations: any[]; executions: any[]; evidencePackages: any[] }> {
  if (!ids(environmentId)) return { plans: [], simulations: [], executions: [], evidencePackages: [] };
  const db = getDb();
  const [plans, simulations, executions, evidencePackages] = await Promise.all([
    db.selectFrom("operational_change_plans").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("created_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("operational_simulation_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("started_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("operational_execution_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("started_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("operational_evidence_packages").select(["id", "execution_run_id", "plan_id", "checksum_sha256", "created_at", "package_json"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("created_at", "desc").orderBy("id").limit(50).execute(),
  ]);
  return { plans, simulations, executions, evidencePackages };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
