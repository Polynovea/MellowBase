import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

// The autonomy policy and desired state belong to planning and reconciliation, which move in later
// wave 4 PRs; here they are fixed so the remediation reads and writes are what is compared.
const policy = { mode: "policy_auto_repair", allowed_remediation_keys: ["world.rediscover"], max_deterministic_classification: "safe" };
const desired: { id: string | null } = { id: null };
vi.mock("@/lib/intelligence/planningService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intelligence/planningService")>()),
  getAutonomyPolicy: vi.fn(async () => policy),
}));
vi.mock("@/lib/intelligence/reconciliationService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intelligence/reconciliationService")>()),
  getActiveDesiredState: vi.fn(async () => (desired.id ? { id: desired.id } : null)),
}));
vi.mock("@/lib/intelligence/worldModelService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intelligence/worldModelService")>()),
  refreshOperationalWorldModel: vi.fn(async () => { throw new Error("World discovery is unavailable in this test"); }),
}));

const { executeDeterministicRemediation, listRemediationRegistry, runPolicyAutoRepair } = await import("@/lib/intelligence/remediationService");

const recorder = createRecorder();

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, 'staging', 'Staging', 'staging') returning id", [workspaceId]);
  const [revision] = await backend.query<{ id: string }>(
    "insert into operational_desired_state_revisions (workspace_id, environment_id, revision, status, desired_json, checksum_sha256) values ($1, $2, 1, 'active', '{}'::jsonb, $3) returning id",
    [workspaceId, environment.id, randomUUID()],
  );
  const [drift] = await backend.query<{ id: string }>(
    "insert into operational_drift_items (workspace_id, environment_id, desired_state_revision_id, drift_key, category, severity, action_class) values ($1, $2, $3, 'world.stale', 'environment', 'warning', 'safe_auto_repair') returning id",
    [workspaceId, environment.id, revision.id],
  );
  return { workspaceId, adminUserId, environmentId: environment.id, revisionId: revision.id, driftId: drift.id };
}

describeBothBackends(["intelligence"], "deterministic remediation", (backend) => {
  it("lists the registry, refuses foreign drift items and records a failed run with its outcome event", async () => {
    const s = await setup(backend);
    const registry = await listRemediationRegistry();
    expect(registry.map((r) => r.remediation_key)).toEqual(expect.arrayContaining(["delivery.replay", "world.rediscover"]));

    const other = await setup(backend);
    const base = { workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId, targetType: "workspace_environment" };
    await expect(executeDeterministicRemediation({ ...base, remediationKey: "world.rediscover", sourceDriftItemId: other.driftId })).rejects.toThrow("Drift item not found in this environment");
    await expect(executeDeterministicRemediation({ ...base, remediationKey: "world.rediscover", sourceDriftItemId: "nope" })).rejects.toThrow("Drift item not found in this environment");
    await expect(executeDeterministicRemediation({ ...base, environmentId: other.environmentId, remediationKey: "world.rediscover" })).rejects.toThrow("Environment not found");
    await expect(executeDeterministicRemediation({ ...base, remediationKey: "no.such.remediation" })).rejects.toThrow("is not registered/enabled");
    expect(await backend.query("select 1 from operational_remediation_runs where workspace_id = $1", [s.workspaceId])).toEqual([]);

    // delivery.replay without a target fails inside the run: the run is marked failed with an outcome event.
    await expect(executeDeterministicRemediation({ ...base, remediationKey: "delivery.replay", sourceDriftItemId: s.driftId })).rejects.toThrow("delivery.replay requires targetId");
    const runs = await backend.query<{ id: string; status: string; error_code: string; source_drift_item_id: string; safe_input_json: unknown }>("select id, status, error_code, source_drift_item_id, safe_input_json from operational_remediation_runs where workspace_id = $1", [s.workspaceId]);
    expect(runs).toEqual([{ id: expect.any(String), status: "failed", error_code: "REMEDIATION_FAILED", source_drift_item_id: s.driftId, safe_input_json: { remediationKey: "delivery.replay", targetType: "workspace_environment", targetId: null } }]);
    const events = await backend.query<{ source_id: string; outcome_json: unknown; features_json: unknown }>("select source_id, outcome_json, features_json from operational_events where workspace_id = $1 and event_type = 'remediation.outcome'", [s.workspaceId]);
    expect(events).toEqual([{ source_id: runs[0].id, outcome_json: { status: "failed", errorClass: "REMEDIATION_FAILED" }, features_json: { remediationKey: "delivery.replay", classification: "safe", executionMode: "manual", environmentKind: "staging", targetType: "workspace_environment" } }]);
    recorder.record(backend.name, "registry", { keys: Object.keys(registry[0]).sort() });
  });

  it("auto-repairs only the environment's own open safe drift", async () => {
    const s = await setup(backend);
    const other = await setup(backend);
    desired.id = s.revisionId;
    const result = await runPolicyAutoRepair({ workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId });
    // world.rediscover fails here (discovery is mocked to fail), so the one candidate is attempted and recorded as failed.
    expect(result).toMatchObject({ candidates: 1, attempted: 1, results: [{ driftId: s.driftId, remediationKey: "world.rediscover", status: "failed" }] });
    desired.id = other.revisionId; // another workspace's desired state finds none of this environment's drift
    expect(await runPolicyAutoRepair({ workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId })).toEqual({ attempted: 0, candidates: 0, results: [] });
    desired.id = null;
    recorder.record(backend.name, "auto-repair", { candidates: result.candidates, attempted: result.attempted });
  });
});

describe("remediation backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
