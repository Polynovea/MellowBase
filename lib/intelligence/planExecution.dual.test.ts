import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

// Environment components and connection verification belong to infrastructure, which moves in a
// later wave; here components are empty and verifying a connection reports it active.
vi.mock("@/lib/infrastructure/operabilityService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infrastructure/operabilityService")>()),
  ensureEnvironmentComponents: vi.fn(async () => []),
}));
vi.mock("@/lib/infrastructure/connectionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infrastructure/connectionService")>()),
  verifyConnection: vi.fn(async () => ({ status: "active" })),
}));

const { createOperationalPlan, executeOperationalPlan, listOperationalPlans, simulateOperationalPlan } = await import("@/lib/intelligence/planningService");
const { createDesiredStateRevision } = await import("@/lib/intelligence/reconciliationService");
const { refreshOperationalWorldModel } = await import("@/lib/intelligence/worldModelService");

const recorder = createRecorder();

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind, status) values ($1, 'staging', 'Staging', 'staging', 'ready') returning id", [workspaceId]);
  const base = { workspaceId, environmentId: environment.id, actorId: adminUserId };
  // The desired state asks for a connection that does not exist, so planning has drift to act on.
  await createDesiredStateRevision({ ...base, activate: true, desired: { schemaVersion: 1, environment: {}, capabilities: {}, connections: { [randomUUID()]: { status: "active" } }, schemas: {}, runtime: {}, websites: {} } });
  await refreshOperationalWorldModel(base);
  const { plan, nodes } = await createOperationalPlan(base);
  return { ...base, adminUserId, planId: plan.id, nodeCount: nodes.length };
}

describeBothBackends(["intelligence"], "operational plan simulation and execution", (backend) => {
  it("simulates a plan and reviews it, inside the workspace only", async () => {
    const s = await setup(backend);
    const simulation = await simulateOperationalPlan({ ...s, planId: s.planId });
    expect(simulation).toMatchObject({ workspace_id: s.workspaceId, plan_id: s.planId, status: "warning", hard_blockers_json: [], approval_json: { required: false, approvalRequestId: null } });
    expect(simulation.warnings_json.map((w: { code: string }) => w.code)).toContain("AUTONOMY_DIAGNOSE_ONLY");
    expect(simulation.side_effects_json).toHaveLength(s.nodeCount);
    const [plan] = await backend.query<{ status: string; reviewed_at: string | null }>("select status, reviewed_at from operational_change_plans where id = $1", [s.planId]);
    expect(plan.status).toBe("reviewed");
    expect(plan.reviewed_at).not.toBeNull();

    const other = await setup(backend);
    await expect(simulateOperationalPlan({ ...other, planId: s.planId })).rejects.toThrow("Operational plan not found");
    await expect(simulateOperationalPlan({ ...s, planId: other.planId })).rejects.toThrow("Operational plan not found");
    recorder.record(backend.name, "simulation", { keys: Object.keys(simulation).sort(), warnings: simulation.warnings_json.map((w: { code: string }) => w.code).sort() });
  });

  it("executes a plan with node runs, a proof package and an operational event, then refuses a stale replay", async () => {
    const s = await setup(backend);
    const result = await executeOperationalPlan({ ...s, planId: s.planId });
    expect(result.execution).toMatchObject({ workspace_id: s.workspaceId, plan_id: s.planId, status: "partial" });
    expect(result.execution.result_json).toMatchObject({ remainingDriftCount: 1, verifiedConvergence: false, failure: null });
    expect(result.evidencePackage).toMatchObject({ execution_run_id: result.execution.id, plan_id: s.planId, package_json: { format: "polynovea-operational-proof", execution: { id: result.execution.id, status: "partial" } } });
    expect(result.evidencePackage.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

    const nodeRuns = await backend.query<{ status: string; attempt: number }>("select status, attempt from operational_execution_node_runs where execution_run_id = $1", [result.execution.id]);
    expect(nodeRuns).toHaveLength(s.nodeCount);
    expect(nodeRuns.every((run) => run.status === "succeeded" && run.attempt === 1)).toBe(true);
    const [plan] = await backend.query<{ status: string }>("select status from operational_change_plans where id = $1", [s.planId]);
    expect(plan.status).toBe("partial");
    const [event] = await backend.query<{ outcome_json: { status: string; remainingDriftCount: number } }>("select outcome_json from operational_events where workspace_id = $1 and event_type = 'plan.execution'", [s.workspaceId]);
    expect(event.outcome_json).toMatchObject({ status: "partial", remainingDriftCount: 1 });
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.plan.executed'", [s.workspaceId])).toHaveLength(1);

    // Executing again: the world model has moved on since the plan, so the replay is blocked.
    const replay = await executeOperationalPlan({ ...s, planId: s.planId });
    expect(replay.evidencePackage).toBeNull();
    expect(replay.execution).toMatchObject({ status: "blocked" });
    expect(replay.simulation.hard_blockers_json.map((b: { code: string }) => b.code)).toContain("WORLD_MODEL_CHANGED");

    const lists = await listOperationalPlans(s.workspaceId, s.environmentId);
    expect(lists.executions.map((e) => e.status).sort()).toEqual(["blocked", "partial"]);
    expect(lists.evidencePackages).toHaveLength(1);
    const other = await backend.createWorkspace();
    await expect(executeOperationalPlan({ workspaceId: other.workspaceId, environmentId: s.environmentId, actorId: other.adminUserId, planId: s.planId })).rejects.toThrow("Operational plan not found");
    recorder.record(backend.name, "execution", { execution: Object.keys(result.execution).sort(), evidence: Object.keys(result.evidencePackage).sort(), nodeStatuses: nodeRuns.map((r) => r.status).sort() });
  });
});

describe("plan execution backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
