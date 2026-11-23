// Supabase path of the environment, credential and connection-lookup reads and writes (queries moved
// from environmentService.ts, credentialProvider.ts, databaseProvisioning.ts and
// supabaseManagement.ts; deleted with the switch at the end of phase 1). Input normalization,
// credential decryption and the connection checks stay in those services.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import type { WorkspaceEnvironmentRow } from "@/lib/infrastructure/types";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export type EnvironmentRows = { environments: any[]; providers: any[]; components: any[]; connections: Array<{ id: string; environment_id: string; status: string }> };
export type CreateEnvironmentArgs = {
  p_workspace_id: string; p_actor_id: string; p_key: string; p_name: string; p_kind: string; p_is_default: boolean;
  p_cms_base_url: string | null; p_public_site_urls: string[]; p_database_provider: string | null; p_storage_provider: string | null; p_runtime_provider: string | null; p_secret_provider_kind: string;
};
export type UpdateEnvironmentArgs = {
  p_workspace_id: string; p_actor_id: string; p_environment_id: string; p_name: string; p_status: string; p_is_default: boolean;
  p_cms_base_url: string | null; p_public_site_urls: string[]; p_database_provider: string | null; p_storage_provider: string | null; p_runtime_provider: string | null; p_config_json: Record<string, unknown>;
};
export type SecretRef = { id: string; workspace_id: string; locator: string; encrypted_value: string | null; state: string; provider_id: string };

/** A duplicate environment key, reported without the database's constraint text. */
export const ENVIRONMENT_KEY_CONFLICT = "An environment with this key already exists in the workspace";

/** The workspace's environments with their secret providers, components and connection statuses. */
export async function environmentRows(workspaceId: string): Promise<EnvironmentRows> {
  const db = createServiceRoleClient();
  const [{ data: environments, error }, { data: providers }, { data: components }, { data: connections }] = await Promise.all([
    db.from("workspace_environments").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: true }),
    db.from("workspace_secret_providers").select("id,environment_id,provider_kind,name,status,config_json,created_at,updated_at").eq("workspace_id", workspaceId),
    db.from("environment_components").select("id,environment_id,capability_key,component_key,provider,required,state,current_version,required_version,last_checked_at,last_error").eq("workspace_id", workspaceId),
    db.from("workspace_connections").select("id,environment_id,status").eq("workspace_id", workspaceId),
  ]);
  if (error) throw new Error(error.message);
  return { environments: environments ?? [], providers: providers ?? [], components: components ?? [], connections: connections ?? [] };
}

/** Creates an environment and its secret provider (cms_create_environment). Throws with a status. */
export async function createEnvironment(args: CreateEnvironmentArgs): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_create_environment", args);
  if (error || !data) {
    const conflict = error?.code === "23505";
    throw Object.assign(new Error(conflict ? ENVIRONMENT_KEY_CONFLICT : error?.message || "Could not create environment"), { status: conflict ? 409 : 400 });
  }
  return data;
}

/** Updates an environment (cms_update_environment). Throws with a status: 404 when it is not in the workspace. */
export async function updateEnvironment(args: UpdateEnvironmentArgs): Promise<WorkspaceEnvironmentRow> {
  const { data, error } = await createServiceRoleClient().rpc("cms_update_environment", args);
  if (error || !data) throw Object.assign(new Error(error?.message || "Could not update environment"), { status: error?.code === "P0002" ? 404 : 400 });
  return data as WorkspaceEnvironmentRow;
}

export async function secretRef(refId: string, workspaceId: string): Promise<SecretRef | null> {
  const { data, error } = await createServiceRoleClient().from("workspace_secret_refs").select("id,workspace_id,locator,encrypted_value,state,provider_id").eq("id", refId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) return null;
  return data ?? null;
}

export async function secretProvider(providerId: string, workspaceId: string): Promise<{ provider_kind: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("workspace_secret_providers").select("provider_kind,status").eq("id", providerId).eq("workspace_id", workspaceId).maybeSingle();
  return data ?? null;
}

export async function secretBindings(workspaceId: string, connectionId: string): Promise<Array<{ purpose: string; secret_ref_id: string }>> {
  const { data, error } = await createServiceRoleClient().from("connection_secret_bindings").select("purpose,secret_ref_id").eq("workspace_id", workspaceId).eq("connection_id", connectionId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The environment's active database connections, newest first. */
export async function databaseConnections(workspaceId: string, environmentId: string): Promise<Array<{ id: string; connector_type: string; name: string; status: string; active: boolean; created_at: string }>> {
  const { data, error } = await createServiceRoleClient().from("workspace_connections").select("id,connector_type,name,status,active,created_at")
    .eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("connector_family", "database")
    .eq("active", true).order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The environment's most recently verified active Supabase project connection. */
export async function activeSupabaseConnection(workspaceId: string, environmentId: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("workspace_connections").select("*")
    .eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("connector_type", "database.supabase")
    .eq("active", true).eq("status", "active").order("last_success_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
