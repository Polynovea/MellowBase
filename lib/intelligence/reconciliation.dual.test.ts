import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";

// The observed world belongs to the world model, which moves in a later wave 4 PR: here it is empty,
// so every desired connection is drift and the reconciliation writes are what is compared.
vi.mock("@/lib/intelligence/worldModelService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intelligence/worldModelService")>()),
  getOperationalWorldModel: vi.fn(async () => ({ nodes: [], edges: [], latestDiscovery: null })),
  refreshOperationalWorldModel: vi.fn(async () => { throw new Error("World discovery is not used in this test"); }),
}));

const { activateDesiredStateRevision, createDesiredStateRevision, getActiveDesiredState, listDesiredStateRevisions, listOperationalDrift, reconcileOperationalState } = await import("@/lib/intelligence/reconciliationService");
const desired = (connections: string[]) => ({
  schemaVersion: 1 as const,
  environment: {},
  capabilities: {},
  connections: Object.fromEntries(connections.map((id) => [id, { status: "active" as const }])),
  schemas: {},
  runtime: {},
  websites: {},
});

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, 'staging', 'Staging', 'staging') returning id", [workspaceId]);
  return { workspaceId, adminUserId, environmentId: environment.id };
}

describeWithDatabase("desired state and reconciliation", (backend) => {
  it("numbers, deduplicates and activates desired-state revisions inside the workspace", async () => {
    const s = await setup(backend);
    const base = { workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId };
    const first = await createDesiredStateRevision({ ...base, desired: desired(["a"]) });
    expect(first).toMatchObject({ revision: 1, status: "draft", source: "user", desired_json: desired(["a"]) });
    const second = await createDesiredStateRevision({ ...base, desired: desired(["a", "b"]), changeNote: "two" });
    expect(second).toMatchObject({ revision: 2, change_note: "two" });
    expect((await createDesiredStateRevision({ ...base, desired: desired(["a"]) })).id).toBe(first.id); // same checksum
    await expect(createDesiredStateRevision({ ...base, desired: { schemaVersion: 2 } as never })).rejects.toThrow("Unsupported desired-state schema version");

    expect(await getActiveDesiredState(s.workspaceId, s.environmentId)).toBeNull();
    const active = await activateDesiredStateRevision({ ...base, revisionId: second.id });
    expect(active).toBeTruthy();
    expect((await getActiveDesiredState(s.workspaceId, s.environmentId))?.id).toBe(second.id);
    expect((await listDesiredStateRevisions(s.workspaceId, s.environmentId)).map((r) => r.revision)).toEqual([2, 1]);

    const other = await setup(backend);
    await expect(activateDesiredStateRevision({ workspaceId: other.workspaceId, environmentId: other.environmentId, actorId: other.adminUserId, revisionId: second.id })).rejects.toThrow();
    await expect(activateDesiredStateRevision({ ...base, revisionId: "nope" })).rejects.toThrow("Desired-state revision not found");
    expect(await listDesiredStateRevisions(other.workspaceId, s.environmentId)).toEqual([]);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.desired_state.created'", [s.workspaceId])).toHaveLength(2);
  });

  it("records drift, resolves drift that went away and completes the run", async () => {
    const s = await setup(backend);
    const base = { workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId };
    const revision = await createDesiredStateRevision({ ...base, desired: desired(["a", "b"]), activate: true });

    const first = await reconcileOperationalState({ ...base, refreshWorld: false });
    expect(first.run).toMatchObject({ status: "drifted", summary_json: { total: 2, warnings: 2, resolved: 0 } });
    expect((await listOperationalDrift(s.workspaceId, s.environmentId)).map((d) => `${d.drift_key}:${d.state}`).sort()).toEqual(["connection.a.status:open", "connection.b.status:open"]);

    // The desired state no longer asks for b: re-reconciling against a revision without it resolves b's drift item.
    await backend.query("update operational_desired_state_revisions set desired_json = $1::jsonb where id = $2", [JSON.stringify(desired(["a"])), revision.id]);
    const second = await reconcileOperationalState({ ...base, refreshWorld: false, desiredStateRevisionId: revision.id });
    expect(second.run).toMatchObject({ status: "drifted", summary_json: { total: 1, resolved: 1 } });
    const drift = await listOperationalDrift(s.workspaceId, s.environmentId);
    expect(drift.map((d) => `${d.drift_key}:${d.state}`).sort()).toEqual(["connection.a.status:open", "connection.b.status:resolved"]);
    expect(drift.find((d) => d.drift_key === "connection.a.status")).toMatchObject({ reconciliation_run_id: second.run.id, current_json: { status: "missing" }, desired_json: { status: "active" } });

    const other = await setup(backend);
    await expect(reconcileOperationalState({ ...base, workspaceId: other.workspaceId, refreshWorld: false })).rejects.toThrow("Environment not found");
    await expect(reconcileOperationalState({ ...base, refreshWorld: false, desiredStateRevisionId: "nope" })).rejects.toThrow("No active desired state");
    expect(await listOperationalDrift(other.workspaceId, s.environmentId)).toEqual([]);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.reconciliation.completed'", [s.workspaceId])).toHaveLength(2);
  });
});
