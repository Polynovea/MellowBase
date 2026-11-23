import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeBothBackends } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

const { createConnection, getConnection, listConnections, rotateConnectionCredential, verifyConnection } = await import("@/lib/infrastructure/connectionService");
const { createEnvironment } = await import("@/lib/infrastructure/environmentService");

const recorder = createRecorder();

beforeAll(() => {
  vi.stubEnv("DUAL_TEST_OPENAI", "sk-dual-test");
  vi.stubEnv("DUAL_TEST_OPENAI_NEXT", "sk-dual-test-next");
});
afterAll(() => vi.unstubAllEnvs());

async function rejection(promise: Promise<unknown>): Promise<{ message: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return { message: (error as Error).message, status: (error as { status?: number }).status };
  }
  throw new Error("expected a rejection");
}

describeBothBackends(["infrastructure"], "workspace connections", (backend) => {
  it("creates, lists, verifies and rotates connections inside the workspace", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { environment } = await createEnvironment({ workspaceId, actorId: adminUserId, key: "dev", name: "Dev", kind: "development", secretProviderKind: "environment" });
    const base = { workspaceId, actorId: adminUserId, environmentId: environment.id };

    const created = await createConnection({ ...base, connectorType: "ai.openai", name: " OpenAI ", credentials: [{ purpose: "api_key", locator: "DUAL_TEST_OPENAI" }] });
    const connectionId = created.connection.id as string;
    expect(created.connection).toMatchObject({ workspace_id: workspaceId, environment_id: environment.id, connector_type: "ai.openai", connector_family: "ai", name: "OpenAI" });
    expect(await rejection(createConnection({ ...base, connectorType: "ai.openai", name: "OpenAI", credentials: [{ purpose: "api_key", locator: "DUAL_TEST_OPENAI" }] }))).toEqual({ message: "A connection with this type and name already exists in the environment", status: 409 });
    await expect(createConnection({ ...base, connectorType: "ai.openai", name: "Plain", credentials: [{ purpose: "api_key", locator: "DUAL_TEST_OPENAI", value: "sk-plaintext" }] })).rejects.toThrow("must reference an environment variable");

    const verification = await verifyConnection({ workspaceId, actorId: adminUserId, connectionId });
    expect(verification).toMatchObject({ connection: { id: connectionId, status: "degraded" }, verification: { connection_id: connectionId, status: "warning" } });
    const listed = await listConnections(workspaceId);
    expect(listed.map((c) => c.id)).toEqual([connectionId]);
    expect(listed[0]).toMatchObject({ environment: { id: environment.id, key: "dev" }, secrets: [{ purpose: "api_key", providerKind: "environment", locator: "DUAL_TEST_OPENAI", maskedHint: "env:DUAL_TEST_OPENAI" }], latestVerification: { status: "warning" } });

    const rotated = await rotateConnectionCredential({ workspaceId, actorId: adminUserId, connectionId, purpose: "api_key", locator: "DUAL_TEST_OPENAI_NEXT" });
    expect(rotated).toMatchObject({ locator: "DUAL_TEST_OPENAI_NEXT", maskedHint: "env:DUAL_TEST_OPENAI_NEXT" });
    expect(await rejection(rotateConnectionCredential({ workspaceId, actorId: adminUserId, connectionId, purpose: "client_email", locator: "X" }))).toEqual({ message: "Unsupported credential purpose for this connector", status: undefined });

    const other = await backend.createWorkspace();
    const foreign = { workspaceId: other.workspaceId, actorId: other.adminUserId };
    expect(await rejection(createConnection({ ...foreign, environmentId: environment.id, connectorType: "ai.openai", name: "Steal" }))).toEqual({ message: "Environment not found", status: 404 });
    expect(await rejection(createConnection({ ...base, environmentId: "nope", connectorType: "ai.openai", name: "Bad" }))).toEqual({ message: "Environment not found", status: 404 });
    expect(await rejection(verifyConnection({ ...foreign, connectionId }))).toEqual({ message: "Connection not found", status: 404 });
    expect(await rejection(verifyConnection({ workspaceId, actorId: adminUserId, connectionId: "nope" }))).toEqual({ message: "Connection not found", status: 404 });
    expect(await rejection(rotateConnectionCredential({ ...foreign, connectionId, purpose: "api_key", locator: "X" }))).toEqual({ message: "Connection not found", status: 404 });
    expect(await listConnections(other.workspaceId)).toEqual([]);
    expect(await getConnection(other.workspaceId, connectionId)).toBeNull();
    recorder.record(backend.name, "connections", { created: Object.keys(created.connection).sort(), listed: Object.keys(listed[0]).sort(), verification: Object.keys(verification).sort(), rotated: Object.keys(rotated).sort() });
  });

  it("requires approval for production rotation and links GA4 connections to analytics", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { environment } = await createEnvironment({ workspaceId, actorId: adminUserId, key: "prod", name: "Prod", kind: "production", secretProviderKind: "environment" });
    const base = { workspaceId, actorId: adminUserId, environmentId: environment.id };
    const created = await createConnection({ ...base, connectorType: "ai.anthropic", name: "Claude", credentials: [{ purpose: "api_key", locator: "DUAL_TEST_OPENAI" }] });
    const blocked = await rejection(rotateConnectionCredential({ workspaceId, actorId: adminUserId, connectionId: created.connection.id, purpose: "api_key", locator: "DUAL_TEST_OPENAI_NEXT" }));
    expect(blocked).toEqual({ message: "Production credential rotation requires approval. Request it from Setup & Infrastructure, then retry.", status: 409 });
    expect(await rejection(rotateConnectionCredential({ workspaceId, actorId: adminUserId, connectionId: created.connection.id, purpose: "api_key", locator: "DUAL_TEST_OPENAI_NEXT", approvalRequestId: "00000000-0000-4000-8000-000000000000" }))).toEqual({ message: "Approved credential rotation request not found", status: 409 });

    const ga4 = await createConnection({ ...base, connectorType: "analytics.ga4", name: "GA4", config: { propertyId: "123456789" } });
    const [linked] = await backend.query<{ legacy_resource_type: string; legacy_resource_id: string }>("select legacy_resource_type, legacy_resource_id from workspace_connections where id = $1", [ga4.connection.id]);
    expect(linked.legacy_resource_type).toBe("analytics_connector");
    expect(await backend.query("select 1 from analytics_connectors where id = $1 and workspace_id = $2 and connection_id = $3", [linked.legacy_resource_id, workspaceId, ga4.connection.id])).toHaveLength(1);
    recorder.record(backend.name, "ga4", { keys: Object.keys(ga4).sort() });
  });
});

describe("connection backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
