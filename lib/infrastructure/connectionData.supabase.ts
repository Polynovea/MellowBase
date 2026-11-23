// Supabase path of the workspace connection reads and writes (queries moved from
// connectionService.ts; deleted with the switch at the end of phase 1). Connector validation,
// credential preparation and verification stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ConnectionRows = { connections: any[]; environments: any[]; bindings: any[]; refs: any[]; providers: any[]; verifications: any[] };
export type CreateConnectionArgs = {
  p_workspace_id: string; p_actor_id: string; p_environment_id: string; p_connector_type: string; p_connector_family: string; p_name: string;
  p_config_json: Record<string, unknown>; p_secret_provider_id: string; p_secrets: unknown[];
};
export type RotateSecretArgs = {
  p_workspace_id: string; p_actor_id: string; p_connection_id: string; p_purpose: string; p_locator: string; p_encrypted_value: string | null;
  p_masked_hint: string | null; p_metadata: Record<string, unknown>; p_approval_request_id: string | null;
};
export type VerificationArgs = {
  p_workspace_id: string; p_actor_id: string; p_connection_id: string; p_status: string; p_checks: unknown[]; p_safe_evidence: Record<string, unknown>;
  p_error_code: string | null; p_error_message: string | null; p_duration_ms: number; p_correlation_id: string;
};

/** A duplicate connection name, reported without the database's constraint text. */
export const CONNECTION_NAME_CONFLICT = "A connection with this type and name already exists in the environment";

/** Everything the connection list shows: connections, environments, bindings, secret refs, providers and recent verifications. */
export async function connectionRows(workspaceId: string): Promise<ConnectionRows> {
  const db = createServiceRoleClient();
  const [{ data: connections, error }, { data: environments }, { data: bindings }, { data: refs }, { data: providers }, { data: verifications }] = await Promise.all([
    db.from("workspace_connections").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }),
    db.from("workspace_environments").select("id,key,name,kind,status").eq("workspace_id", workspaceId),
    db.from("connection_secret_bindings").select("connection_id,secret_ref_id,purpose").eq("workspace_id", workspaceId),
    db.from("workspace_secret_refs").select("id,provider_id,label,locator,masked_hint,state,last_verified_at,rotated_at").eq("workspace_id", workspaceId),
    db.from("workspace_secret_providers").select("id,provider_kind").eq("workspace_id", workspaceId),
    db.from("connection_verifications").select("id,connection_id,status,checks_json,safe_evidence_json,error_code,error_message,duration_ms,correlation_id,verified_at").eq("workspace_id", workspaceId).order("verified_at", { ascending: false }).limit(1000),
  ]);
  if (error) throw new Error(error.message);
  return { connections: connections ?? [], environments: environments ?? [], bindings: bindings ?? [], refs: refs ?? [], providers: providers ?? [], verifications: verifications ?? [] };
}

export async function environmentInWorkspace(workspaceId: string, environmentId: string): Promise<{ id: string; kind: string; status: string; secret_provider_id: string | null } | null> {
  const { data } = await createServiceRoleClient().from("workspace_environments").select("id,kind,status,secret_provider_id").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  return data ?? null;
}

export async function environmentProvider(workspaceId: string, environmentId: string, providerId: string): Promise<{ id: string; provider_kind: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("workspace_secret_providers").select("id,provider_kind,status").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", providerId).maybeSingle();
  return data ?? null;
}

/** Creates a connection with its secrets (cms_create_connection) and, for GA4, links it to analytics. Throws with a status. */
export async function createConnection(args: CreateConnectionArgs, linkGa4: boolean): Promise<any> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("cms_create_connection", args);
  if (error || !data) {
    const conflict = error?.code === "23505";
    throw Object.assign(new Error(conflict ? CONNECTION_NAME_CONFLICT : error?.message || "Could not create connection"), { status: conflict ? 409 : 400 });
  }
  const connectionId = (data as { connection?: { id?: string } }).connection?.id;
  if (linkGa4 && connectionId) {
    const { error: linkError } = await db.rpc("cms_link_ga4_connection", { p_workspace_id: args.p_workspace_id, p_actor_id: args.p_actor_id, p_connection_id: connectionId });
    if (linkError) throw new Error(linkError.message || "GA4 connection was created but could not be linked to analytics");
  }
  return data;
}

export async function connectionRow(workspaceId: string, connectionId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("workspace_connections").select("*").eq("workspace_id", workspaceId).eq("id", connectionId).maybeSingle();
  return data ?? null;
}

export async function secretBinding(workspaceId: string, connectionId: string, purpose: string): Promise<{ secret_ref_id: string } | null> {
  const { data } = await createServiceRoleClient().from("connection_secret_bindings").select("secret_ref_id").eq("workspace_id", workspaceId).eq("connection_id", connectionId).eq("purpose", purpose).maybeSingle();
  return data ?? null;
}

/** Approved credential-rotation requests for the connection, latest review first (at most 20). */
export async function approvedRotationRequests(workspaceId: string, environmentId: string, connectionId: string): Promise<Array<{ id: string; request_json: any; expires_at: string | null }>> {
  const { data } = await createServiceRoleClient().from("infrastructure_approval_requests").select("id,request_json,expires_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("operation", "credential_rotate").eq("entity_id", connectionId).eq("status", "approved").order("reviewed_at", { ascending: false }).limit(20);
  return data ?? [];
}

/** Rotates a connection credential (cms_rotate_connection_secret_governed). Throws with a status: 409 for approval problems. */
export async function rotateSecret(args: RotateSecretArgs): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_rotate_connection_secret_governed", args);
  if (error || !data) throw Object.assign(new Error(error?.message || "Could not rotate credential"), { status: error?.code === "P0001" ? 409 : 400 });
  return data;
}

export async function markVerifying(workspaceId: string, connectionId: string): Promise<void> {
  await createServiceRoleClient().from("workspace_connections").update({ status: "verifying", updated_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", connectionId);
}

/** Records a verification (cms_record_connection_verification). Throws when it could not be recorded. */
export async function recordVerification(args: VerificationArgs): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_record_connection_verification", args);
  if (error || !data) throw new Error(error?.message || "Could not record connection verification");
  return data;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
