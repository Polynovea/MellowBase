// PostgreSQL implementation of the developer API tokens (phase 1, wave 2).
//
// token generation, scopes and validation are shared in apiTokenService.ts. Deliberate differences
// from the Supabase path it replaced in phase 1:
// - Creating a token writes the row and its audit event in one transaction; revoking locks the row,
// so two concurrent revokes audit once, and the update and audit commit together.
// - The per-minute rate limit is still cms_consume_developer_api_rate_limit (atomic in SQL).
// - Recording last use is best effort, as before, but its failure is logged instead of becoming an
// unhandled rejection.
// - Malformed IDs are "not found"; the list has an explicit limit; every statement is scoped by
// workspace_id except the lookup by token hash, which is how a request finds its workspace.
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PreparedDeveloperApiToken, RateLimitResult } from "@/lib/developer/apiTokenService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

export async function listDeveloperApiTokens(workspaceId: string) {
  return getDb()
    .selectFrom("developer_api_tokens")
    .select(["id", "name", "token_prefix", "scopes", "allowed_models", "rate_limit_per_minute", "expires_at", "last_used_at", "revoked_at", "created_by", "created_at", "updated_at"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(DEFAULT_LIST_LIMIT)
    .execute();
}

export async function insertDeveloperApiToken(params: { workspaceId: string; actorId: string; token: PreparedDeveloperApiToken }) {
  const { token } = params;
  return withTransaction(async (trx) => {
    const data = expectOne(await trx
      .insertInto("developer_api_tokens")
      .values({
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
      .returning(["id", "name", "token_prefix", "scopes", "allowed_models", "rate_limit_per_minute", "expires_at", "created_at"])
      .execute(), "Could not create API token");

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorId,
      action: "developer.api_token.created",
      entityType: "developer_api_token",
      entityId: data.id,
      metadata: { name: token.name, scopes: token.scopes, allowedModels: token.allowedModels, rateLimitPerMinute: token.rateLimit, expiresAt: token.expiresAt },
    });
    return data;
  });
}

export async function revokeDeveloperApiToken(params: { workspaceId: string; actorId: string; tokenId: string }) {
  if (!isUuid(params.tokenId)) throw new Error("API token not found");
  return withTransaction(async (trx) => {
    const existing = maybeOne(await trx
      .selectFrom("developer_api_tokens")
      .select(["id", "name", "revoked_at"])
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.tokenId)
      .forUpdate()
      .execute());
    if (!existing) throw new Error("API token not found");
    if (existing.revoked_at) return existing;

    const now = new Date().toISOString();
    const data = expectOne(await trx
      .updateTable("developer_api_tokens")
      .set({ revoked_at: now, updated_at: now })
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.tokenId)
      .returning(["id", "name", "revoked_at"])
      .execute(), "Could not revoke API token");

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorId,
      action: "developer.api_token.revoked",
      entityType: "developer_api_token",
      entityId: params.tokenId,
      metadata: { name: existing.name },
    });
    return data;
  });
}

export async function findDeveloperApiTokenByHash(tokenHash: string) {
  return maybeOne(await getDb()
    .selectFrom("developer_api_tokens")
    .select(["id", "workspace_id", "name", "token_prefix", "scopes", "allowed_models", "rate_limit_per_minute", "expires_at", "last_used_at", "revoked_at", "created_by", "agent_identity_id"])
    .where("token_hash", "=", tokenHash)
    .execute());
}

export async function consumeDeveloperApiRateLimit(tokenId: string, limit: number): Promise<RateLimitResult | null> {
  const result = await callFunction("cms_consume_developer_api_rate_limit", { p_token_id: tokenId, p_limit: limit });
  return (result ?? null) as RateLimitResult | null;
}

export function touchDeveloperApiToken(tokenId: string): void {
  void getDb()
    .updateTable("developer_api_tokens")
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", tokenId)
    .execute()
    .catch((error: unknown) => {
      console.error("developer API token last use was not recorded", { tokenId, error: error instanceof Error ? error.message : String(error) });
    });
}
