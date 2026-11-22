// Supabase path of the agent and extension governance primitives (deleted with the switch at the end
// of phase 1). Queries moved from agentGovernanceService.ts, extensionGovernanceService.ts and
// extensionHostService.ts; the rules (key formats, privilege subsets, tool access) stay there.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";
import type { AgentIdentityRecord } from "@/lib/developer/agentGovernanceService";
import type { ExtensionInstallationRow, ExtensionPermissionGrant } from "@/lib/developer/governanceData";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services returned them */
const AGENT_COLUMNS = "id,workspace_id,agent_key,name,status,default_mode,provider,model,metadata_json,created_by,updated_by,created_at,updated_at";

export async function listAgentIdentities(workspaceId: string): Promise<AgentIdentityRecord[]> {
  const { data, error } = await createServiceRoleClient()
    .from("agent_identities")
    .select(AGENT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentIdentityRecord[];
}

export async function insertAgentIdentity(row: Record<string, unknown>, audit: (agent: AgentIdentityRecord) => PlatformAuditPayload): Promise<AgentIdentityRecord> {
  const { data, error } = await createServiceRoleClient().from("agent_identities").insert(row).select(AGENT_COLUMNS).single();
  if (error || !data) throw new Error(error?.message || "Could not create agent identity");
  const agent = data as AgentIdentityRecord;
  await logPlatformEvent(audit(agent));
  return agent;
}

/** Checks the token and agent, then binds them and audits. */
export async function bindTokenToAgent(params: { workspaceId: string; actorId: string; tokenId: string; agentIdentityId: string }) {
  const db = createServiceRoleClient();
  const [{ data: token, error: tokenError }, { data: agent, error: agentError }] = await Promise.all([
    db.from("developer_api_tokens").select("id,workspace_id,agent_identity_id,revoked_at").eq("workspace_id", params.workspaceId).eq("id", params.tokenId).maybeSingle(),
    db.from("agent_identities").select("id,workspace_id,status,agent_key").eq("workspace_id", params.workspaceId).eq("id", params.agentIdentityId).maybeSingle(),
  ]);
  if (tokenError || agentError) throw new Error(tokenError?.message || agentError?.message || "Could not validate agent binding");
  if (!token) throw new Error("Developer API token not found in workspace");
  if (!agent) throw new Error("Agent identity not found in workspace");
  if (token.revoked_at) throw new Error("Cannot bind a revoked developer API token");
  if (agent.status !== "active") throw new Error("Cannot bind a non-active agent identity");

  const { data, error } = await db.from("developer_api_tokens")
    .update({ agent_identity_id: params.agentIdentityId, updated_at: new Date().toISOString() })
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.tokenId)
    .select("id,workspace_id,agent_identity_id")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not bind developer API token to agent");

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "agent.token.bound",
    entityType: "agent_identity",
    entityId: params.agentIdentityId,
    metadata: { tokenId: params.tokenId, agentKey: agent.agent_key },
  });
  return data;
}

/** The token's bound agent when the token is live and the agent active, else null. */
export async function findBoundAgent(params: { workspaceId: string; tokenId: string }): Promise<{ token: any; agent: any } | null> {
  const db = createServiceRoleClient();
  const { data: token, error } = await db.from("developer_api_tokens")
    .select("id,workspace_id,agent_identity_id,scopes,revoked_at")
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.tokenId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!token || token.revoked_at || !token.agent_identity_id) return null;

  const { data: agent, error: agentError } = await db.from("agent_identities")
    .select("id,workspace_id,agent_key,name,status,default_mode,provider,model,metadata_json")
    .eq("workspace_id", params.workspaceId)
    .eq("id", token.agent_identity_id)
    .maybeSingle();
  if (agentError) throw new Error(agentError.message);
  if (!agent || agent.status !== "active") return null;
  return { token, agent };
}

export async function insertAgentProvenance(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("agent_operation_provenance").insert(row).select("*").single();
  if (error || !data) throw new Error(error?.message || "Could not record agent provenance");
  return data;
}

export async function insertExtensionManifest(row: Record<string, unknown>, audit: (manifest: { id: string }) => PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("extension_manifests").insert(row).select("*").single();
  if (error || !data) throw Object.assign(new Error(error?.message || "Could not register extension manifest"), { status: 400 });
  await logPlatformEvent(audit(data));
  return data;
}

export async function findExtensionManifest(workspaceId: string, manifestId: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("extension_manifests").select("*").eq("workspace_id", workspaceId).eq("id", manifestId).maybeSingle();
  if (error) return null;
  return data;
}

/** Upserts the installation, one grant row per requested permission, then audits. */
export async function saveExtensionInstallation(params: { installation: Record<string, unknown>; grants: (installationId: string) => ExtensionPermissionGrant[]; audit: (installation: { id: string }) => PlatformAuditPayload }): Promise<ExtensionInstallationRow> {
  const db = createServiceRoleClient();
  const { data, error: installError } = await db.from("extension_installations").upsert(params.installation, { onConflict: "workspace_id,manifest_id" }).select("*").single();
  if (installError || !data) throw new Error(installError?.message || "Could not install extension");
  for (const grant of params.grants(data.id)) await db.from("extension_permission_grants").upsert(grant, { onConflict: "installation_id,permission_key" });
  await logPlatformEvent(params.audit(data));
  return data;
}

/** The installation with its manifest's key and JSON, or null. */
export async function findExtensionInstallation(workspaceId: string, installationId: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("extension_installations").select("id,workspace_id,status,granted_permissions,granted_network_json,granted_connections_json,extension_manifests!inner(extension_key,manifest_json)").eq("workspace_id", workspaceId).eq("id", installationId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function findWorkspaceConnection(workspaceId: string, connectionId: string): Promise<{ id: string; name: string; connector_family: string; connector_type: string; status: string; active: boolean; environment_id: string } | null> {
  const { data, error } = await createServiceRoleClient().from("workspace_connections").select("id,name,connector_family,connector_type,status,active,environment_id").eq("workspace_id", workspaceId).eq("id", connectionId).maybeSingle();
  if (error) return null;
  return data;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
