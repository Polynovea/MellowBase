// Agent and extension governance: database primitives. The services keep every rule (agent key
// format, tool access, requested-privilege subsets, namespace checks) and call these.
import * as postgres from "@/lib/developer/governanceData.postgres";

export interface ExtensionPermissionGrant {
  workspace_id: string;
  installation_id: string;
  permission_key: string;
  decision: "granted" | "denied";
  granted_by: string;
  updated_at: string;
}

export interface ExtensionInstallationRow {
  id: string;
  workspace_id: string;
  manifest_id: string;
  status: string;
  [column: string]: unknown;
}


export const listAgentIdentities = postgres.listAgentIdentities;
export const insertAgentIdentity = postgres.insertAgentIdentity;
export const bindTokenToAgent = postgres.bindTokenToAgent;
export const findBoundAgent = postgres.findBoundAgent;
export const insertAgentProvenance = postgres.insertAgentProvenance;
export const insertExtensionManifest = postgres.insertExtensionManifest;
export const findExtensionManifest = postgres.findExtensionManifest;
export const saveExtensionInstallation = postgres.saveExtensionInstallation;
export const findExtensionInstallation = postgres.findExtensionInstallation;
export const findWorkspaceConnection = postgres.findWorkspaceConnection;
