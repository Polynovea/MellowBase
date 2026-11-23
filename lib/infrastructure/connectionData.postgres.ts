// Direct PostgreSQL implementation of the workspace connection reads and writes (phase 1, wave 5).
// Same signatures and shapes as connectionData.supabase.ts. Differences that are deliberate:
// - Creating a GA4 connection and linking it to analytics commit together. The Supabase path could
//   leave a GA4 connection that analytics never sees when the link failed.
// - Messages the connection functions raise for the caller pass through; a duplicate name is
//   reported as a conflict without the constraint text; other database text never reaches the caller.
// - Reads have id tie-breaks and bounds; malformed ids find nothing instead of failing on the uuid cast.
import { callFunction, DEFAULT_LIST_LIMIT, getDb, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { CONNECTION_NAME_CONFLICT } from "@/lib/infrastructure/connectionData.supabase";
import type { ConnectionRows, CreateConnectionArgs, RotateSecretArgs, VerificationArgs } from "@/lib/infrastructure/connectionData.supabase";

export type { ConnectionRows, CreateConnectionArgs, RotateSecretArgs, VerificationArgs } from "@/lib/infrastructure/connectionData.supabase";
export { CONNECTION_NAME_CONFLICT } from "@/lib/infrastructure/connectionData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: Array<string | null | undefined>) => values.every((value) => typeof value === "string" && UUID.test(value));

export async function connectionRows(workspaceId: string): Promise<ConnectionRows> {
  const db = getDb();
  const [connections, environments, bindings, refs, providers, verifications] = await Promise.all([
    db.selectFrom("workspace_connections").selectAll().where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("workspace_environments").select(["id", "key", "name", "kind", "status"]).where("workspace_id", "=", workspaceId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("connection_secret_bindings").select(["connection_id", "secret_ref_id", "purpose"]).where("workspace_id", "=", workspaceId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("workspace_secret_refs").select(["id", "provider_id", "label", "locator", "masked_hint", "state", "last_verified_at", "rotated_at"]).where("workspace_id", "=", workspaceId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("workspace_secret_providers").select(["id", "provider_kind"]).where("workspace_id", "=", workspaceId).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("connection_verifications").select(["id", "connection_id", "status", "checks_json", "safe_evidence_json", "error_code", "error_message", "duration_ms", "correlation_id", "verified_at"]).where("workspace_id", "=", workspaceId).orderBy("verified_at", "desc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
  ]);
  return { connections, environments, bindings, refs, providers, verifications };
}

export async function environmentInWorkspace(workspaceId: string, environmentId: string): Promise<{ id: string; kind: string; status: string; secret_provider_id: string | null } | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("workspace_environments").select(["id", "kind", "status", "secret_provider_id"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst()) ?? null;
}

export async function environmentProvider(workspaceId: string, environmentId: string, providerId: string): Promise<{ id: string; provider_kind: string; status: string } | null> {
  if (!ids(environmentId, providerId)) return null;
  return (await getDb().selectFrom("workspace_secret_providers").select(["id", "provider_kind", "status"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", providerId).executeTakeFirst()) ?? null;
}

export async function createConnection(args: CreateConnectionArgs, linkGa4: boolean): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const data = await callFunction("cms_create_connection", { ...args, p_config_json: JSON.stringify(args.p_config_json), p_secrets: JSON.stringify(args.p_secrets) } as never, trx);
      if (!data) throw new Error("Could not create connection");
      const connectionId = (data as { connection?: { id?: string } }).connection?.id;
      if (linkGa4 && connectionId) await callFunction("cms_link_ga4_connection", { p_workspace_id: args.p_workspace_id, p_actor_id: args.p_actor_id, p_connection_id: connectionId }, trx);
      return data;
    });
  } catch (error) {
    if (error instanceof SqlFunctionError) throw Object.assign(new Error(error.message), { status: 400 });
    if ((error as { code?: unknown })?.code === "23505") throw Object.assign(new Error(CONNECTION_NAME_CONFLICT), { status: 409 });
    throw Object.assign(new Error(clientErrorMessage(error, "Could not create connection")), { status: 400 });
  }
}

export async function connectionRow(workspaceId: string, connectionId: string): Promise<any | null> {
  if (!ids(connectionId)) return null;
  return (await getDb().selectFrom("workspace_connections").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", connectionId).executeTakeFirst()) ?? null;
}

export async function secretBinding(workspaceId: string, connectionId: string, purpose: string): Promise<{ secret_ref_id: string } | null> {
  if (!ids(connectionId)) return null;
  return (await getDb().selectFrom("connection_secret_bindings").select("secret_ref_id").where("workspace_id", "=", workspaceId).where("connection_id", "=", connectionId).where("purpose", "=", purpose).executeTakeFirst()) ?? null;
}

export async function approvedRotationRequests(workspaceId: string, environmentId: string, connectionId: string): Promise<Array<{ id: string; request_json: any; expires_at: string | null }>> {
  if (!ids(environmentId)) return [];
  return getDb().selectFrom("infrastructure_approval_requests").select(["id", "request_json", "expires_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("operation", "=", "credential_rotate").where("entity_id", "=", connectionId).where("status", "=", "approved")
    .orderBy("reviewed_at", "desc").orderBy("id").limit(20).execute();
}

export async function rotateSecret(args: RotateSecretArgs): Promise<any> {
  if (!ids(args.p_connection_id)) throw Object.assign(new Error("Connection not found in workspace"), { status: 400 });
  if (args.p_approval_request_id !== null && !ids(args.p_approval_request_id)) throw Object.assign(new Error("Approved credential rotation request not found"), { status: 409 });
  let data: unknown;
  try {
    data = await callFunction("cms_rotate_connection_secret_governed", { ...args, p_metadata: JSON.stringify(args.p_metadata) } as never);
  } catch (error) {
    if (error instanceof SqlFunctionError) throw Object.assign(new Error(error.message), { status: error.sqlState === "P0001" ? 409 : 400 });
    throw Object.assign(new Error(clientErrorMessage(error, "Could not rotate credential")), { status: 400 });
  }
  if (!data) throw Object.assign(new Error("Could not rotate credential"), { status: 400 });
  return data;
}

export async function markVerifying(workspaceId: string, connectionId: string): Promise<void> {
  if (!ids(connectionId)) return;
  await getDb().updateTable("workspace_connections").set({ status: "verifying", updated_at: new Date().toISOString() }).where("workspace_id", "=", workspaceId).where("id", "=", connectionId).execute();
}

export async function recordVerification(args: VerificationArgs): Promise<any> {
  let data: unknown;
  try {
    data = await callFunction("cms_record_connection_verification", { ...args, p_checks: JSON.stringify(args.p_checks), p_safe_evidence: JSON.stringify(args.p_safe_evidence) } as never);
  } catch (error) {
    if (error instanceof SqlFunctionError) throw new Error(error.message);
    throw new Error(clientErrorMessage(error, "Could not record connection verification"));
  }
  if (!data) throw new Error("Could not record connection verification");
  return data;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
