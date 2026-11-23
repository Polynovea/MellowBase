import { describe, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { ISO_TIMESTAMP } from "@/lib/db/testing/http";
import { createDeveloperApiToken, revokeDeveloperApiToken } from "@/lib/developer/apiTokenService";
import {
  authorizeBoundAgentTool,
  bindDeveloperTokenToAgent,
  createAgentIdentity,
  listAgentIdentities,
  recordAgentOperationProvenance,
  resolveBoundAgent,
} from "@/lib/developer/agentGovernanceService";
import { getActiveExtensionPrivileges, installExtension, registerExtensionManifest } from "@/lib/developer/extensionGovernanceService";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
const AGENT_KEYS = ["agent_key", "created_at", "created_by", "default_mode", "id", "metadata_json", "model", "name", "provider", "status", "updated_at", "updated_by", "workspace_id"];

const manifest = (version = "1.0.0") => ({
  schemaVersion: 1 as const,
  extensionKey: "analytics.example",
  name: "Analytics Example",
  version,
  compatibleCoreVersions: [">=1.0.0"],
  permissions: ["analytics.read", "analytics.write"],
  routes: [{ method: "GET" as const, path: "/extensions/analytics.example/report", permission: "analytics.read" }],
  events: { subscribe: ["content.entry.published"], emit: [] },
  fields: [],
  adminExtensions: [],
  networkRequirements: [{ origin: "https://api.example.com", methods: ["GET" as const] }],
  requiredCapabilities: ["analytics"],
  requestedConnections: [{ connectorFamily: "analytics", connectorTypes: ["analytics.ga4"], scopes: ["analytics.read"] }],
});

describeWithDatabase("agent and extension governance", (backend) => {
  it("creates agents, binds a token, resolves and authorizes the bound agent, and records provenance", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const agent = await createAgentIdentity({ workspaceId, actorId: adminUserId, agentKey: " Writer.Bot ", name: " Writer ", provider: " anthropic ", metadata: { tier: 1 } });
    expect(Object.keys(agent).sort()).toEqual(AGENT_KEYS);
    expect(agent).toMatchObject({ agent_key: "writer.bot", name: "Writer", provider: "anthropic", model: null, status: "active", default_mode: "draft_only", metadata_json: { tier: 1 } });
    expect(agent.created_at).toMatch(ISO_TIMESTAMP);
    await expect(createAgentIdentity({ workspaceId, actorId: adminUserId, agentKey: "!bad", name: "x" })).rejects.toThrow("Agent key is invalid");
    expect((await listAgentIdentities(workspaceId)).map((a) => a.id)).toEqual([agent.id]);

    const { token, secret } = await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "Agent token", scopes: ["content.read"] });
    expect(await resolveBoundAgent({ workspaceId, tokenId: token.id })).toBeNull();
    const bound = await bindDeveloperTokenToAgent({ workspaceId, actorId: adminUserId, tokenId: token.id, agentIdentityId: agent.id });
    expect(bound).toEqual({ id: token.id, workspace_id: workspaceId, agent_identity_id: agent.id });
    expect((await resolveBoundAgent({ workspaceId, tokenId: token.id }))?.agent).toMatchObject({ id: agent.id, agent_key: "writer.bot" });

    const read = await authorizeBoundAgentTool({ workspaceId, tokenId: token.id, toolName: "cms.content.search" });
    expect(read).toMatchObject({ allowed: true });
    // A bound token is checked against its agent on the API path too.
    const viaApi = await requireDeveloperApi(new Request("http://cms.test/api/v1/entries", { headers: { authorization: `Bearer ${secret}` } }), { scope: "content.read", agentToolName: "cms.content.search" });
    expect(viaApi.data).toMatchObject({ agentIdentityId: agent.id, agentToolName: "cms.content.search" });

    const provenance = await recordAgentOperationProvenance({
      workspaceId, agentIdentityId: agent.id, developerApiTokenId: token.id, requestId: "req-9", toolName: "cms.content.search",
      status: "succeeded", sourceContext: [{ kind: "query" }], changedFields: ["a", "a", "b"], safeInputSummary: { q: "x" },
    });
    expect(provenance).toMatchObject({ tool_name: "cms.content.search", operation_class: "read", changed_fields: ["a", "b"], source_context_json: [{ kind: "query" }] });
    expect(provenance.input_digest_sha256).toMatch(/^[0-9a-f]{64}$/);

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'agent_identity' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["agent.identity.created", "agent.token.bound"]);
  });

  it("never binds a revoked token or a suspended agent, nor across workspaces", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const agent = await createAgentIdentity({ workspaceId, actorId: adminUserId, agentKey: "agent-one", name: "One" });
    const { token } = await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "T", scopes: ["content.read"] });
    await revokeDeveloperApiToken({ workspaceId, actorId: adminUserId, tokenId: token.id });
    await expect(bindDeveloperTokenToAgent({ workspaceId, actorId: adminUserId, tokenId: token.id, agentIdentityId: agent.id })).rejects.toThrow("revoked");

    const live = await createDeveloperApiToken({ workspaceId, actorId: adminUserId, name: "Live", scopes: ["content.read"] });
    await backend.query("update agent_identities set status = 'suspended' where id = $1", [agent.id]);
    await expect(bindDeveloperTokenToAgent({ workspaceId, actorId: adminUserId, tokenId: live.token.id, agentIdentityId: agent.id })).rejects.toThrow("non-active");

    const other = await backend.createWorkspace();
    const otherAgent = await createAgentIdentity({ workspaceId: other.workspaceId, actorId: other.adminUserId, agentKey: "agent-two", name: "Two" });
    await expect(bindDeveloperTokenToAgent({ workspaceId, actorId: adminUserId, tokenId: live.token.id, agentIdentityId: otherAgent.id })).rejects.toThrow("Agent identity not found in workspace");
    await expect(bindDeveloperTokenToAgent({ workspaceId: other.workspaceId, actorId: other.adminUserId, tokenId: live.token.id, agentIdentityId: otherAgent.id })).rejects.toThrow("token not found");
    expect(await listAgentIdentities(other.workspaceId)).toHaveLength(1);
    expect(await resolveBoundAgent({ workspaceId: other.workspaceId, tokenId: live.token.id })).toBeNull();
  });

  it("registers and installs extensions with only requested privileges, and records every grant", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const registered = await registerExtensionManifest({ workspaceId, actorId: adminUserId, input: manifest() });
    expect(registered).toMatchObject({ extension_key: "analytics.example", version: "1.0.0", requested_permissions: ["analytics.read", "analytics.write"] });
    expect(registered.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(registerExtensionManifest({ workspaceId, actorId: adminUserId, input: manifest() })).rejects.toMatchObject({ status: 400 });

    await expect(installExtension({ workspaceId, actorId: adminUserId, manifestId: registered.id, grantedPermissions: ["content.delete"] })).rejects.toMatchObject({ status: 409 });
    await expect(installExtension({ workspaceId, actorId: adminUserId, manifestId: registered.id, grantedNetwork: ["https://evil.example"] })).rejects.toMatchObject({ status: 409 });
    const installed = await installExtension({ workspaceId, actorId: adminUserId, manifestId: registered.id, grantedPermissions: ["analytics.read"], grantedNetwork: ["https://api.example.com"], configuration: { mode: "safe" } });
    expect(installed).toMatchObject({ status: "installed", granted_permissions: ["analytics.read"], granted_network_json: ["https://api.example.com"], configuration_json: { mode: "safe" } });
    const grantRows = await backend.query<{ permission_key: string; decision: string }>("select permission_key, decision from extension_permission_grants where installation_id = $1 order by permission_key", [installed.id]);
    expect(grantRows).toEqual([{ permission_key: "analytics.read", decision: "granted" }, { permission_key: "analytics.write", decision: "denied" }]);

    // Re-installing updates the same installation and its grants.
    const again = await installExtension({ workspaceId, actorId: adminUserId, manifestId: registered.id, grantedPermissions: ["analytics.read", "analytics.write"] });
    expect(again.id).toBe(installed.id);
    expect((await backend.query<{ decision: string }>("select decision from extension_permission_grants where installation_id = $1 order by permission_key", [installed.id])).map((r) => r.decision)).toEqual(["granted", "granted"]);

    const active = await getActiveExtensionPrivileges(workspaceId, installed.id);
    expect(active).toMatchObject({ id: installed.id, status: "installed", extension_manifests: { extension_key: "analytics.example" } });
    await backend.query("update extension_installations set status = 'disabled' where id = $1", [installed.id]);
    await expect(getActiveExtensionPrivileges(workspaceId, installed.id)).rejects.toMatchObject({ status: 403 });

    const other = await backend.createWorkspace();
    await expect(installExtension({ workspaceId: other.workspaceId, actorId: other.adminUserId, manifestId: registered.id })).rejects.toMatchObject({ status: 404 });
    await expect(getActiveExtensionPrivileges(other.workspaceId, installed.id)).rejects.toMatchObject({ status: 403 });
  });
});
