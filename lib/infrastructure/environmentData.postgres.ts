// Direct PostgreSQL implementation of the environment, credential and connection-lookup reads and
// writes (phase 1, wave 5). Same signatures and shapes as environmentData.supabase.ts. Differences
// that are deliberate:
// - Environment reads have id tie-breaks, and every list is bounded.
// - Messages the environment functions raise for the caller pass through; a duplicate key is
//   reported as a conflict without the constraint text; other database text never reaches the caller.
// - Malformed ids find nothing instead of failing on the uuid cast.
import { sql } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, getDb, SqlFunctionError } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { ENVIRONMENT_KEY_CONFLICT } from "@/lib/infrastructure/environmentData.supabase";
import type { CreateEnvironmentArgs, EnvironmentRows, SecretRef, UpdateEnvironmentArgs } from "@/lib/infrastructure/environmentData.supabase";
import type { WorkspaceEnvironmentRow } from "@/lib/infrastructure/types";

export type { CreateEnvironmentArgs, EnvironmentRows, SecretRef, UpdateEnvironmentArgs } from "@/lib/infrastructure/environmentData.supabase";
export { ENVIRONMENT_KEY_CONFLICT } from "@/lib/infrastructure/environmentData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));

function functionError(error: unknown, fallback: string): Error {
  if (error instanceof SqlFunctionError) return Object.assign(new Error(error.message), { status: error.sqlState === "P0002" ? 404 : 400 });
  if ((error as { code?: unknown })?.code === "23505") return Object.assign(new Error(ENVIRONMENT_KEY_CONFLICT), { status: 409 });
  return Object.assign(new Error(clientErrorMessage(error, fallback)), { status: 400 });
}

export async function environmentRows(workspaceId: string): Promise<EnvironmentRows> {
  const db = getDb();
  const [environments, providers, components, connections] = await Promise.all([
    db.selectFrom("workspace_environments").selectAll().where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("workspace_secret_providers").select(["id", "environment_id", "provider_kind", "name", "status", "config_json", "created_at", "updated_at"]).where("workspace_id", "=", workspaceId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("environment_components").select(["id", "environment_id", "capability_key", "component_key", "provider", "required", "state", "current_version", "required_version", "last_checked_at", "last_error"]).where("workspace_id", "=", workspaceId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    // Only counted per environment, so the whole workspace is read.
    db.selectFrom("workspace_connections").select(["id", "environment_id", "status"]).where("workspace_id", "=", workspaceId).execute(),
  ]);
  return { environments, providers, components, connections: connections as EnvironmentRows["connections"] };
}

export async function createEnvironment(args: CreateEnvironmentArgs): Promise<any> {
  let data: unknown;
  try {
    data = await callFunction("cms_create_environment", { ...args, p_public_site_urls: JSON.stringify(args.p_public_site_urls) } as never);
  } catch (error) {
    throw functionError(error, "Could not create environment");
  }
  if (!data) throw Object.assign(new Error("Could not create environment"), { status: 400 });
  return data;
}

export async function updateEnvironment(args: UpdateEnvironmentArgs): Promise<WorkspaceEnvironmentRow> {
  if (!ids(args.p_environment_id)) throw Object.assign(new Error("Environment not found in workspace"), { status: 404 });
  let data: unknown;
  try {
    data = await callFunction("cms_update_environment", { ...args, p_public_site_urls: JSON.stringify(args.p_public_site_urls), p_config_json: JSON.stringify(args.p_config_json) } as never);
  } catch (error) {
    throw functionError(error, "Could not update environment");
  }
  if (!data) throw Object.assign(new Error("Could not update environment"), { status: 400 });
  return data as WorkspaceEnvironmentRow;
}

export async function secretRef(refId: string, workspaceId: string): Promise<SecretRef | null> {
  if (!ids(refId)) return null;
  return ((await getDb().selectFrom("workspace_secret_refs").select(["id", "workspace_id", "locator", "encrypted_value", "state", "provider_id"])
    .where("id", "=", refId).where("workspace_id", "=", workspaceId).executeTakeFirst()) as SecretRef | undefined) ?? null;
}

export async function secretProvider(providerId: string, workspaceId: string): Promise<{ provider_kind: string; status: string } | null> {
  if (!ids(providerId)) return null;
  return (await getDb().selectFrom("workspace_secret_providers").select(["provider_kind", "status"]).where("id", "=", providerId).where("workspace_id", "=", workspaceId).executeTakeFirst()) ?? null;
}

export async function secretBindings(workspaceId: string, connectionId: string): Promise<Array<{ purpose: string; secret_ref_id: string }>> {
  if (!ids(connectionId)) return [];
  return getDb().selectFrom("connection_secret_bindings").select(["purpose", "secret_ref_id"])
    .where("workspace_id", "=", workspaceId).where("connection_id", "=", connectionId).orderBy("purpose").limit(DEFAULT_LIST_LIMIT).execute();
}

export async function databaseConnections(workspaceId: string, environmentId: string): Promise<Array<{ id: string; connector_type: string; name: string; status: string; active: boolean; created_at: string }>> {
  if (!ids(environmentId)) return [];
  return getDb().selectFrom("workspace_connections").select(["id", "connector_type", "name", "status", "active", "created_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("connector_family", "=", "database").where("active", "=", true)
    .orderBy("created_at", "desc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute();
}

export async function activeSupabaseConnection(workspaceId: string, environmentId: string): Promise<any | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("workspace_connections").selectAll()
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("connector_type", "=", "database.supabase")
    .where("active", "=", true).where("status", "=", "active").orderBy(sql`last_success_at desc nulls last`).orderBy("id").limit(1).executeTakeFirst()) ?? null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
