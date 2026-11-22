// Supabase path of the developer API tokens (deleted with the switch at the end of phase 1). Token
// generation and validation live in apiTokenService.ts and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import type { PreparedDeveloperApiToken, RateLimitResult } from "@/lib/developer/apiTokenService";

export async function listDeveloperApiTokens(workspaceId: string) {
  const { data, error } = await createServiceRoleClient()
    .from("developer_api_tokens")
    .select("id, name, token_prefix, scopes, allowed_models, rate_limit_per_minute, expires_at, last_used_at, revoked_at, created_by, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function insertDeveloperApiToken(params: { workspaceId: string; actorId: string; token: PreparedDeveloperApiToken }) {
  const { token } = params;
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("developer_api_tokens")
    .insert({
      workspace_id: params.workspaceId,
      name: token.name,
      token_prefix: token.tokenPrefix,
      token_hash: token.tokenHash,
      scopes: token.scopes,
      allowed_models: token.allowedModels,
      rate_limit_per_minute: token.rateLimit,
      expires_at: token.expiresAt,
      created_by: params.actorId,
    })
    .select("id, name, token_prefix, scopes, allowed_models, rate_limit_per_minute, expires_at, created_at")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create API token");

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "developer.api_token.created",
    entityType: "developer_api_token",
    entityId: data.id,
    metadata: { name: token.name, scopes: token.scopes, allowedModels: token.allowedModels, rateLimitPerMinute: token.rateLimit, expiresAt: token.expiresAt },
  });
  return data;
}

export async function revokeDeveloperApiToken(params: { workspaceId: string; actorId: string; tokenId: string }) {
  const db = createServiceRoleClient();
  const { data: existing } = await db
    .from("developer_api_tokens")
    .select("id, name, revoked_at")
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.tokenId)
    .maybeSingle();
  if (!existing) throw new Error("API token not found");
  if (existing.revoked_at) return existing;
  const { data, error } = await db
    .from("developer_api_tokens")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.tokenId)
    .select("id, name, revoked_at")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not revoke API token");
  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "developer.api_token.revoked",
    entityType: "developer_api_token",
    entityId: params.tokenId,
    metadata: { name: existing.name },
  });
  return data;
}

export async function findDeveloperApiTokenByHash(tokenHash: string) {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("developer_api_tokens")
    .select("id, workspace_id, name, token_prefix, scopes, allowed_models, rate_limit_per_minute, expires_at, last_used_at, revoked_at, created_by, agent_identity_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Moved from apiAuth.ts: one request against the token's per-minute limit. Null when unavailable. */
export async function consumeDeveloperApiRateLimit(tokenId: string, limit: number): Promise<RateLimitResult | null> {
  const { data: rateRaw, error: rateError } = await createServiceRoleClient().rpc("cms_consume_developer_api_rate_limit", {
    p_token_id: tokenId,
    p_limit: limit,
  });
  if (rateError || !rateRaw) return null;
  return rateRaw as RateLimitResult;
}

/**
 * Moved from apiAuth.ts: best effort, never awaited by the request. A supabase-js query only runs when
 * it is awaited or `.then`-ed; the old `void db.from(...).update(...)` never sent the update, so
 * last_used_at was never recorded.
 */
export function touchDeveloperApiToken(tokenId: string): void {
  createServiceRoleClient().from("developer_api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tokenId)
    .then(({ error }) => {
      if (error) console.error("developer API token last use was not recorded", { tokenId, error: error.message });
    });
}
