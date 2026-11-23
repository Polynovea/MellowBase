import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

const { createEnvironment, getEnvironment, listEnvironments, updateEnvironment } = await import("@/lib/infrastructure/environmentService");
const { resolveConnectionCredentials, resolveCredentialRef } = await import("@/lib/infrastructure/credentialProvider");
const environmentData = await import("@/lib/infrastructure/environmentData");

const recorder = createRecorder();
const SECRET = "dual-test-credential-value";

beforeAll(() => vi.stubEnv("DUAL_TEST_INFRA_SECRET", SECRET));
afterAll(() => vi.unstubAllEnvs());

async function rejection(promise: Promise<unknown>): Promise<{ message: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return { message: (error as Error).message, status: (error as { status?: number }).status };
  }
  throw new Error("expected a rejection");
}

async function connectionWithSecret(backend: BackendFixtures, workspaceId: string, environmentId: string, providerId: string, connectorType: string, extra = "") {
  const [ref] = await backend.query<{ id: string }>("insert into workspace_secret_refs (workspace_id, environment_id, provider_id, secret_key, label, locator) values ($1, $2, $3, $4, 'Connection URL', 'DUAL_TEST_INFRA_SECRET') returning id", [workspaceId, environmentId, providerId, `k${randomUUID().slice(0, 8)}`]);
  const [connection] = await backend.query<{ id: string }>(`insert into workspace_connections (workspace_id, environment_id, connector_type, connector_family, name, status${extra ? ", last_success_at" : ""}) values ($1, $2, $3, 'database', $4, 'active'${extra ? ", $5" : ""}) returning id`, [workspaceId, environmentId, connectorType, `Conn ${randomUUID().slice(0, 8)}`, ...(extra ? [extra] : [])]);
  await backend.query("insert into connection_secret_bindings (workspace_id, connection_id, secret_ref_id, purpose) values ($1, $2, $3, 'connection_url')", [workspaceId, connection.id, ref.id]);
  return { refId: ref.id, connectionId: connection.id };
}

describeBothBackends(["infrastructure"], "environments, credentials and connection lookups", (backend) => {
  it("creates, lists and updates environments inside the workspace", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const created = await createEnvironment({ workspaceId, actorId: adminUserId, key: " Staging ", name: " Staging ", kind: "staging", isDefault: true, cmsBaseUrl: "https://cms.example.test/", publicSiteUrls: ["https://www.example.test/", "https://www.example.test"], secretProviderKind: "environment" });
    expect(created.environment).toMatchObject({ workspace_id: workspaceId, key: "staging", name: "Staging", is_default: true, cms_base_url: "https://cms.example.test", public_site_urls: ["https://www.example.test"], status: "disconnected" });
    expect(created.secretProvider).toMatchObject({ provider_kind: "environment", name: "Environment Variables" });

    expect(await rejection(createEnvironment({ workspaceId, actorId: adminUserId, key: "staging", name: "Again", kind: "staging" }))).toEqual({ message: "An environment with this key already exists in the workspace", status: 409 });
    expect(await rejection(createEnvironment({ workspaceId, actorId: adminUserId, key: "odd", name: "Odd", kind: "moon" as never }))).toEqual({ message: "Unsupported environment kind", status: 400 });
    const second = await createEnvironment({ workspaceId, actorId: adminUserId, key: "prod", name: "Prod", kind: "production", isDefault: true });

    const listed = await listEnvironments(workspaceId);
    expect(listed.map((e) => [e.key, e.is_default])).toEqual([["staging", false], ["prod", true]]);
    expect(listed[0]).toMatchObject({ secretProviders: [{ provider_kind: "environment" }], components: [], connectionSummary: { total: 0, healthy: 0, degraded: 0 } });

    const updated = await updateEnvironment({ workspaceId, actorId: adminUserId, environmentId: created.environment.id, name: " Stage ", status: "ready", isDefault: false, publicSiteUrls: [], config: { region: "eu" } });
    expect(updated).toMatchObject({ id: created.environment.id, name: "Stage", status: "ready", config_json: { region: "eu" }, public_site_urls: [] });
    expect(await rejection(updateEnvironment({ workspaceId, actorId: adminUserId, environmentId: created.environment.id, name: "x", status: "melting" as never, isDefault: false }))).toEqual({ message: "Unsupported environment status", status: 400 });

    const other = await backend.createWorkspace();
    expect(await rejection(updateEnvironment({ workspaceId: other.workspaceId, actorId: other.adminUserId, environmentId: created.environment.id, name: "x", status: "ready", isDefault: false }))).toEqual({ message: "Environment not found in workspace", status: 404 });
    expect(await rejection(updateEnvironment({ workspaceId, actorId: adminUserId, environmentId: "nope", name: "x", status: "ready", isDefault: false }))).toEqual({ message: "Environment not found in workspace", status: 404 });
    expect(await listEnvironments(other.workspaceId)).toEqual([]);
    expect(await getEnvironment(other.workspaceId, second.environment.id)).toBeNull();
    expect(await backend.query("select action from platform_audit_events where workspace_id = $1 order by created_at", [workspaceId])).toEqual([{ action: "environment.created" }, { action: "environment.created" }, { action: "environment.updated" }]);
    recorder.record(backend.name, "environments", { created: Object.keys(created.environment).sort(), listed: Object.keys(listed[0]).sort(), updated: Object.keys(updated).sort() });
  });

  it("resolves credentials and finds connections only inside the workspace", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { environment, secretProvider } = await createEnvironment({ workspaceId, actorId: adminUserId, key: "dev", name: "Dev", kind: "development", secretProviderKind: "environment" });
    const postgresConn = await connectionWithSecret(backend, workspaceId, environment.id, secretProvider.id, "database.postgres");
    const older = await connectionWithSecret(backend, workspaceId, environment.id, secretProvider.id, "database.supabase", "2020-01-01T00:00:00Z");
    const newer = await connectionWithSecret(backend, workspaceId, environment.id, secretProvider.id, "database.supabase", "2024-01-01T00:00:00Z");

    expect(await resolveCredentialRef(postgresConn.refId, workspaceId)).toBe(SECRET);
    expect(await resolveConnectionCredentials(workspaceId, postgresConn.connectionId)).toEqual({ connection_url: SECRET });
    expect((await environmentData.databaseConnections(workspaceId, environment.id)).map((c) => c.id).sort()).toEqual([postgresConn.connectionId, older.connectionId, newer.connectionId].sort());
    expect((await environmentData.activeSupabaseConnection(workspaceId, environment.id))?.id).toBe(newer.connectionId);

    const other = await backend.createWorkspace();
    await expect(resolveCredentialRef(postgresConn.refId, other.workspaceId)).rejects.toThrow("Credential reference is unavailable");
    await expect(resolveCredentialRef("nope", workspaceId)).rejects.toThrow("Credential reference is unavailable");
    expect(await resolveConnectionCredentials(other.workspaceId, postgresConn.connectionId)).toEqual({});
    expect(await environmentData.databaseConnections(other.workspaceId, environment.id)).toEqual([]);
    expect(await environmentData.activeSupabaseConnection(other.workspaceId, environment.id)).toBeNull();

    await backend.query("update workspace_secret_providers set status = 'disabled' where id = $1", [secretProvider.id]);
    await expect(resolveCredentialRef(postgresConn.refId, workspaceId)).rejects.toThrow("Credential provider is unavailable");
    recorder.record(backend.name, "credentials", { connection: Object.keys((await environmentData.databaseConnections(workspaceId, environment.id))[0]).sort() });
  });
});

describe("environment backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
