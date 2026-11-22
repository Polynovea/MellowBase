// Agent and extension governance: database primitives with the backend dispatcher (the `developer`
// switch in POLYNOVEA_DATA_BACKEND). The services keep every rule (agent key format, tool access,
// requested-privilege subsets, namespace checks) and call these, so both paths enforce them the same.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/developer/governanceData.postgres";
import * as supabase from "@/lib/developer/governanceData.supabase";

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

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("developer") ? direct : supabase);

export const listAgentIdentities: typeof supabase.listAgentIdentities = (...args) => impl().listAgentIdentities(...args);
export const insertAgentIdentity: typeof supabase.insertAgentIdentity = (...args) => impl().insertAgentIdentity(...args);
export const bindTokenToAgent: typeof supabase.bindTokenToAgent = (...args) => impl().bindTokenToAgent(...args);
export const findBoundAgent: typeof supabase.findBoundAgent = (...args) => impl().findBoundAgent(...args);
export const insertAgentProvenance: typeof supabase.insertAgentProvenance = (...args) => impl().insertAgentProvenance(...args);
export const insertExtensionManifest: typeof supabase.insertExtensionManifest = (...args) => impl().insertExtensionManifest(...args);
export const findExtensionManifest: typeof supabase.findExtensionManifest = (...args) => impl().findExtensionManifest(...args);
export const saveExtensionInstallation: typeof supabase.saveExtensionInstallation = (...args) => impl().saveExtensionInstallation(...args);
export const findExtensionInstallation: typeof supabase.findExtensionInstallation = (...args) => impl().findExtensionInstallation(...args);
export const findWorkspaceConnection: typeof supabase.findWorkspaceConnection = (...args) => impl().findWorkspaceConnection(...args);
