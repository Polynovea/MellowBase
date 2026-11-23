import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

// Environment components belong to infrastructure, which moves in a later wave.
vi.mock("@/lib/infrastructure/operabilityService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infrastructure/operabilityService")>()),
  ensureEnvironmentComponents: vi.fn(async () => []),
}));

const { createOperationalPlan, getAutonomyPolicy, getOperationalPlan, listOperationalPlans, updateAutonomyPolicy } = await import("@/lib/intelligence/planningService");
const { createDesiredStateRevision, reconcileOperationalState } = await import("@/lib/intelligence/reconciliationService");
const { refreshOperationalWorldModel } = await import("@/lib/intelligence/worldModelService");

const recorder = createRecorder();

async function setup(backend: BackendFixtures, kind = "staging") {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind, status) values ($1, $2, 'Env', $2, 'ready') returning id", [workspaceId, kind]);
  return { workspaceId, adminUserId, environmentId: environment.id };
}

describeBothBackends(["intelligence"], "autonomy policy and operational plans", (backend) => {
  it("creates the default policy once and validates policy updates", async () => {
    const s = await setup(backend, "production");
    const policy = await getAutonomyPolicy(s.workspaceId, s.environmentId);
    expect(policy).toMatchObject({ workspace_id: s.workspaceId, environment_id: s.environmentId, mode: "diagnose_only" });
    expect((await getAutonomyPolicy(s.workspaceId, s.environmentId)).id).toBe(policy.id);

    const base = { workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId };
    await expect(updateAutonomyPolicy({ ...base, mode: "chaos" as never })).rejects.toThrow("Unsupported autonomy mode");
    await expect(updateAutonomyPolicy({ ...base, mode: "recommend", maxDeterministicClassification: "destructive" as never })).rejects.toThrow("Unsupported maximum classification");
    await expect(updateAutonomyPolicy({ ...base, mode: "policy_auto_repair", maxDeterministicClassification: "requires_lock" })).rejects.toThrow("Production policy auto-repair may only cover deterministically SAFE remediations");
    const updated = await updateAutonomyPolicy({ ...base, mode: "policy_auto_repair", allowedRemediationKeys: ["world.rediscover", "world.rediscover"], settings: { note: "x" } });
    expect(updated).toMatchObject({ id: policy.id, mode: "policy_auto_repair", allowed_remediation_keys: ["world.rediscover"], max_deterministic_classification: "safe", settings_json: { note: "x" }, updated_by: s.adminUserId });

    const other = await setup(backend);
    await expect(updateAutonomyPolicy({ workspaceId: other.workspaceId, environmentId: s.environmentId, actorId: other.adminUserId, mode: "recommend" })).rejects.toThrow("Environment not found");
    await expect(getAutonomyPolicy(s.workspaceId, "nope")).rejects.toThrow("Environment not found");
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.autonomy_policy.updated'", [s.workspaceId])).toHaveLength(1);
    recorder.record(backend.name, "policy", { keys: Object.keys(updated).sort() });
  });

  it("plans from drift, persists the plan graph and marks its drift planned", async () => {
    const s = await setup(backend);
    const base = { workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId };
    await expect(createOperationalPlan(base)).rejects.toThrow("No desired state is available for planning");
    const ghost = randomUUID();
    await createDesiredStateRevision({ ...base, activate: true, desired: { schemaVersion: 1, environment: {}, capabilities: {}, connections: { [ghost]: { status: "active" } }, schemas: {}, runtime: {}, websites: {} } });
    await expect(createOperationalPlan(base)).rejects.toThrow("Run operational discovery before planning");
    await refreshOperationalWorldModel({ ...base });

    const other = await setup(backend);
    const otherBase = { workspaceId: other.workspaceId, environmentId: other.environmentId, actorId: other.adminUserId };
    await createDesiredStateRevision({ ...otherBase, activate: true, desired: { schemaVersion: 1, environment: {}, capabilities: {}, connections: {}, schemas: {}, runtime: {}, websites: {} } });
    const foreignRun = await reconcileOperationalState({ ...otherBase, refreshWorld: false });
    await expect(createOperationalPlan({ ...base, reconciliationRunId: foreignRun.run.id })).rejects.toThrow("Reconciliation run not found in this environment");
    await expect(createOperationalPlan({ ...base, reconciliationRunId: "nope" })).rejects.toThrow("Reconciliation run not found in this environment");

    const created = await createOperationalPlan({ ...base, name: " Fix drift " });
    expect(created.plan).toMatchObject({ workspace_id: s.workspaceId, environment_id: s.environmentId, name: "Fix drift", status: "planned" });
    expect(created.plan.immutable_plan_json).toMatchObject({ nodes: expect.any(Array) });
    expect(created.nodes.length).toBe(created.plan.immutable_plan_json.nodes.length);
    expect(created.nodes.every((node: { plan_id: string }) => node.plan_id === created.plan.id)).toBe(true);
    const drift = await backend.query<{ state: string }>("select state from operational_drift_items where workspace_id = $1", [s.workspaceId]);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.every((d) => d.state === "planned")).toBe(true);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.plan.created'", [s.workspaceId])).toHaveLength(1);

    expect((await getOperationalPlan(s.workspaceId, created.plan.id)).plan.id).toBe(created.plan.id);
    await expect(getOperationalPlan(other.workspaceId, created.plan.id)).rejects.toThrow("Operational plan not found");
    await expect(getOperationalPlan(s.workspaceId, "nope")).rejects.toThrow("Operational plan not found");
    const lists = await listOperationalPlans(s.workspaceId, s.environmentId);
    expect(lists.plans.map((p) => p.id)).toEqual([created.plan.id]);
    expect(await listOperationalPlans(other.workspaceId, s.environmentId)).toEqual({ plans: [], simulations: [], executions: [], evidencePackages: [] });
    recorder.record(backend.name, "plan", { plan: Object.keys(created.plan).sort(), nodes: created.nodes.map((n: { operation: string }) => n.operation).sort(), edgeCount: created.edges.length });
  });
});

describe("planning backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
