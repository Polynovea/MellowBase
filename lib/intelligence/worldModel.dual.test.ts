import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";

// Environment components belong to infrastructure, which moves in a later wave; here the
// environment has none, so the world model is derived from its connections and runtime state.
vi.mock("@/lib/infrastructure/operabilityService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infrastructure/operabilityService")>()),
  ensureEnvironmentComponents: vi.fn(async () => []),
}));

const { buildGeneratedDesiredState, getOperationalWorldModel, refreshOperationalWorldModel } = await import("@/lib/intelligence/worldModelService");

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind, status) values ($1, 'staging', 'Staging', 'staging', 'ready') returning id", [workspaceId]);
  const [analytics] = await backend.query<{ id: string }>(
    "insert into workspace_connections (workspace_id, environment_id, connector_type, connector_family, name, status, active) values ($1, $2, 'analytics.ga4', 'analytics', 'GA4', 'active', true) returning id",
    [workspaceId, environment.id],
  );
  const [webhook] = await backend.query<{ id: string }>(
    "insert into workspace_connections (workspace_id, environment_id, connector_type, connector_family, name, status, active) values ($1, $2, 'webhook.generic', 'webhook', 'Hook', 'active', true) returning id",
    [workspaceId, environment.id],
  );
  return { workspaceId, adminUserId, environmentId: environment.id, analyticsId: analytics.id, webhookId: webhook.id };
}

const keys = (rows: Array<{ node_key: string; is_stale: boolean }>) => rows.map((n) => `${n.node_key.replace(/[0-9a-f-]{36}/g, "*")}${n.is_stale ? ":stale" : ""}`).sort();

describeWithDatabase("operational world model", (backend) => {
  it("discovers the environment, keeps node identities across runs and marks what disappeared stale", async () => {
    const s = await setup(backend);
    const first = await refreshOperationalWorldModel({ workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId, source: "manual" });
    expect(first.run).toMatchObject({ workspace_id: s.workspaceId, status: "succeeded", source: "manual" });
    expect(first.summary).toMatchObject({ nodes: first.nodes.length, edges: first.edges.length, environmentStatus: "ready" });
    const world = await getOperationalWorldModel(s.workspaceId, s.environmentId);
    expect(world.nodes.map((n) => n.node_key)).toEqual(expect.arrayContaining([`environment:${s.environmentId}`, `connection:${s.analyticsId}`, `connection:${s.webhookId}`]));
    expect(world.edges.length).toBe(first.edges.length);
    expect(world.latestDiscovery?.id).toBe(first.run.id);
    const observations = await backend.query<{ n: number }>("select count(*)::int as n from operational_observations where discovery_run_id = $1", [first.run.id]);
    expect(observations[0].n).toBe(first.nodes.length + first.edges.length);

    await backend.query("delete from workspace_connections where id = $1", [s.webhookId]);
    const second = await refreshOperationalWorldModel({ workspaceId: s.workspaceId, environmentId: s.environmentId });
    const after = await getOperationalWorldModel(s.workspaceId, s.environmentId);
    expect(after.nodes.find((n) => n.node_key === `environment:${s.environmentId}`)?.id).toBe(world.nodes.find((n) => n.node_key === `environment:${s.environmentId}`)?.id);
    expect(after.nodes.find((n) => n.node_key === `connection:${s.webhookId}`)).toMatchObject({ is_stale: true });
    expect(after.nodes.find((n) => n.node_key === `connection:${s.analyticsId}`)).toMatchObject({ is_stale: false });
    expect(after.latestDiscovery?.id).toBe(second.run.id);

    const other = await setup(backend);
    await expect(refreshOperationalWorldModel({ workspaceId: other.workspaceId, environmentId: s.environmentId })).rejects.toThrow("Environment not found");
    await expect(refreshOperationalWorldModel({ workspaceId: s.workspaceId, environmentId: "nope" })).rejects.toThrow("Environment not found");
    expect(await getOperationalWorldModel(other.workspaceId, s.environmentId)).toEqual({ nodes: [], edges: [], latestDiscovery: null });
  });

  it("builds the generated desired state from the workspace's environment only", async () => {
    const s = await setup(backend);
    const desired = await buildGeneratedDesiredState(s.workspaceId, s.environmentId);
    expect(desired).toMatchObject({ schemaVersion: 1, environment: { status: "ready" }, capabilities: {}, schemas: {}, websites: {}, metadata: { environmentKind: "staging" } });
    expect(Object.keys(desired.connections).sort()).toEqual([s.analyticsId, s.webhookId].sort());
    const other = await backend.createWorkspace();
    await expect(buildGeneratedDesiredState(other.workspaceId, s.environmentId)).rejects.toThrow("Environment not found");
  });
});
