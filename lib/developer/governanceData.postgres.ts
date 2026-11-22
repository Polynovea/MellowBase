// Direct PostgreSQL implementation of the agent and extension governance primitives (phase 1, wave 2).
//
// Same signatures and return shapes as governanceData.supabase.ts. Differences that are deliberate:
// - Binding a token to an agent locks both rows and re-checks them in the transaction that binds and
//   audits, so a token revoked (or an agent suspended) a moment earlier can never be bound.
// - Installing an extension writes the installation, every permission grant and the audit event in
//   one transaction. The Supabase path ignored errors from the grant upserts, so an install could
//   succeed with grant rows missing.
// - Creating an agent or registering a manifest commits with its audit event.
// - Malformed IDs are "not found"; every statement is scoped by workspace_id.
import { DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { AgentIdentityRecord } from "@/lib/developer/agentGovernanceService";
import type { ExtensionInstallationRow, ExtensionPermissionGrant } from "@/lib/developer/governanceData";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services returned them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const AGENT_COLUMNS = ["id", "workspace_id", "agent_key", "name", "status", "default_mode", "provider", "model", "metadata_json", "created_by", "updated_by", "created_at", "updated_at"] as const;

/** jsonb values are serialized here; the driver would send a JS array as a PostgreSQL array. */
function withJson(row: Record<string, unknown>, jsonColumns: string[]): any {
  const out: Record<string, unknown> = { ...row };
  for (const column of jsonColumns) {
    if (out[column] !== undefined && out[column] !== null) out[column] = JSON.stringify(out[column]);
  }
  return out;
}

export async function listAgentIdentities(workspaceId: string): Promise<AgentIdentityRecord[]> {
  const rows = await getDb().selectFrom("agent_identities").select(AGENT_COLUMNS)
    .where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id", "desc").limit(DEFAULT_LIST_LIMIT).execute();
  return rows as unknown as AgentIdentityRecord[];
}

export async function insertAgentIdentity(row: Record<string, unknown>, audit: (agent: AgentIdentityRecord) => PlatformAuditPayload): Promise<AgentIdentityRecord> {
  return withTransaction(async (trx) => {
    const agent = expectOne(await trx.insertInto("agent_identities").values(withJson(row, ["metadata_json"])).returning(AGENT_COLUMNS).execute(), "Could not create agent identity") as unknown as AgentIdentityRecord;
    await recordPlatformEvent(trx, audit(agent));
    return agent;
  });
}

export async function bindTokenToAgent(params: { workspaceId: string; actorId: string; tokenId: string; agentIdentityId: string }) {
  if (!isUuid(params.tokenId)) throw new Error("Developer API token not found in workspace");
  if (!isUuid(params.agentIdentityId)) throw new Error("Agent identity not found in workspace");
  return withTransaction(async (trx) => {
    const token = maybeOne(await trx.selectFrom("developer_api_tokens").select(["id", "workspace_id", "agent_identity_id", "revoked_at"])
      .where("workspace_id", "=", params.workspaceId).where("id", "=", params.tokenId).forUpdate().execute());
    const agent = maybeOne(await trx.selectFrom("agent_identities").select(["id", "workspace_id", "status", "agent_key"])
      .where("workspace_id", "=", params.workspaceId).where("id", "=", params.agentIdentityId).forShare().execute());
    if (!token) throw new Error("Developer API token not found in workspace");
    if (!agent) throw new Error("Agent identity not found in workspace");
    if (token.revoked_at) throw new Error("Cannot bind a revoked developer API token");
    if (agent.status !== "active") throw new Error("Cannot bind a non-active agent identity");

    const data = expectOne(await trx.updateTable("developer_api_tokens")
      .set({ agent_identity_id: params.agentIdentityId, updated_at: new Date().toISOString() })
      .where("workspace_id", "=", params.workspaceId).where("id", "=", params.tokenId)
      .returning(["id", "workspace_id", "agent_identity_id"]).execute(), "Could not bind developer API token to agent");

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorId,
      action: "agent.token.bound",
      entityType: "agent_identity",
      entityId: params.agentIdentityId,
      metadata: { tokenId: params.tokenId, agentKey: agent.agent_key },
    });
    return data;
  });
}

export async function findBoundAgent(params: { workspaceId: string; tokenId: string }): Promise<{ token: any; agent: any } | null> {
  if (!isUuid(params.tokenId)) return null;
  const db = getDb();
  const token = maybeOne(await db.selectFrom("developer_api_tokens").select(["id", "workspace_id", "agent_identity_id", "scopes", "revoked_at"])
    .where("workspace_id", "=", params.workspaceId).where("id", "=", params.tokenId).execute());
  if (!token || token.revoked_at || !token.agent_identity_id) return null;
  const agent = maybeOne(await db.selectFrom("agent_identities")
    .select(["id", "workspace_id", "agent_key", "name", "status", "default_mode", "provider", "model", "metadata_json"])
    .where("workspace_id", "=", params.workspaceId).where("id", "=", token.agent_identity_id).execute());
  if (!agent || agent.status !== "active") return null;
  return { token, agent };
}

export async function insertAgentProvenance(row: Record<string, unknown>): Promise<any> {
  return expectOne(await getDb().insertInto("agent_operation_provenance")
    .values(withJson(row, ["source_context_json", "before_json", "after_json", "metadata_json"]))
    .returningAll().execute(), "Could not record agent provenance");
}

const MANIFEST_JSON = ["routes_json", "events_json", "fields_json", "admin_extensions_json", "network_requirements_json", "requested_connections_json", "manifest_json"];

export async function insertExtensionManifest(row: Record<string, unknown>, audit: (manifest: { id: string }) => PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const manifest = expectOne(await trx.insertInto("extension_manifests").values(withJson(row, MANIFEST_JSON)).returningAll().execute(), "Could not register extension manifest");
      await recordPlatformEvent(trx, audit(manifest));
      return manifest;
    });
  } catch (error) {
    throw Object.assign(new Error((error as { code?: string })?.code === "23505" ? "This extension version is already registered" : "Could not register extension manifest"), { status: 400, cause: error });
  }
}

export async function findExtensionManifest(workspaceId: string, manifestId: string): Promise<any | null> {
  if (!isUuid(manifestId)) return null;
  return maybeOne(await getDb().selectFrom("extension_manifests").selectAll()
    .where("workspace_id", "=", workspaceId).where("id", "=", manifestId).execute());
}

export async function saveExtensionInstallation(params: { installation: Record<string, unknown>; grants: (installationId: string) => ExtensionPermissionGrant[]; audit: (installation: { id: string }) => PlatformAuditPayload }): Promise<ExtensionInstallationRow> {
  return withTransaction(async (trx) => {
    const values = withJson(params.installation, ["granted_network_json", "granted_connections_json", "configuration_json"]);
    const installation = expectOne(await trx.insertInto("extension_installations").values(values)
      // Same as the Supabase upsert on (workspace_id, manifest_id): every column it sent.
      .onConflict((conflict) => conflict.columns(["workspace_id", "manifest_id"]).doUpdateSet(
        Object.fromEntries(Object.keys(values).filter((column) => column !== "workspace_id" && column !== "manifest_id").map((column) => [column, (eb: any) => eb.ref(`excluded.${column}`)])) as any,
      ))
      .returningAll().execute(), "Could not install extension") as unknown as ExtensionInstallationRow;
    for (const grant of params.grants(installation.id)) {
      await trx.insertInto("extension_permission_grants").values(grant)
        .onConflict((conflict) => conflict.columns(["installation_id", "permission_key"]).doUpdateSet((eb) => ({
          workspace_id: eb.ref("excluded.workspace_id"),
          decision: eb.ref("excluded.decision"),
          granted_by: eb.ref("excluded.granted_by"),
          updated_at: eb.ref("excluded.updated_at"),
        })))
        .execute();
    }
    await recordPlatformEvent(trx, params.audit(installation));
    return installation;
  });
}

export async function findExtensionInstallation(workspaceId: string, installationId: string): Promise<any | null> {
  if (!isUuid(installationId)) return null;
  const row = maybeOne(await getDb()
    .selectFrom("extension_installations as i")
    .innerJoin("extension_manifests as m", (join) => join.onRef("m.id", "=", "i.manifest_id").onRef("m.workspace_id", "=", "i.workspace_id"))
    .select(["i.id", "i.workspace_id", "i.status", "i.granted_permissions", "i.granted_network_json", "i.granted_connections_json", "m.extension_key", "m.manifest_json"])
    .where("i.workspace_id", "=", workspaceId).where("i.id", "=", installationId).execute());
  if (!row) return null;
  const { extension_key, manifest_json, ...installation } = row;
  return { ...installation, extension_manifests: { extension_key, manifest_json } };
}

export async function findWorkspaceConnection(workspaceId: string, connectionId: string): Promise<{ id: string; name: string; connector_family: string; connector_type: string; status: string; active: boolean; environment_id: string } | null> {
  if (!isUuid(connectionId)) return null;
  return maybeOne(await getDb().selectFrom("workspace_connections")
    .select(["id", "name", "connector_family", "connector_type", "status", "active", "environment_id"])
    .where("workspace_id", "=", workspaceId).where("id", "=", connectionId).execute());
}
/* eslint-enable @typescript-eslint/no-explicit-any */
