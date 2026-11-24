/**
 * Who is asking: turns an API token, an admin, or a preview token's issuer into a Principal for
 * resolveModelAccess. Roles are always read within the principal's workspace (a role of another
 * workspace never counts), from active memberships only.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import { mergeLimitOverrides, type Principal, type PrincipalKind } from "@/lib/developer/items/access";
import type { ApiLimits } from "@/lib/developer/items/types";

interface RoleRow {
  id: string;
  key: string;
  api_limits: unknown;
}

const limitsOf = (rows: RoleRow[]) =>
  mergeLimitOverrides(rows.map((row) => (row.api_limits && typeof row.api_limits === "object" && !Array.isArray(row.api_limits) ? row.api_limits as Partial<ApiLimits> : null)));

async function memberRoles(db: Kysely<DB>, workspaceId: string, adminUserId: string): Promise<RoleRow[] | null> {
  const member = await db.selectFrom("workspace_members").select(["id", "status"])
    .where("workspace_id", "=", workspaceId).where("admin_user_id", "=", adminUserId).executeTakeFirst();
  if (!member || member.status !== "active") return null;
  return db.selectFrom("member_roles as mr").innerJoin("roles as r", "r.id", "mr.role_id")
    .select(["r.id", "r.key", "r.api_limits"])
    .where("mr.workspace_member_id", "=", member.id).where("r.workspace_id", "=", workspaceId)
    .orderBy("r.key").execute();
}

/**
 * An API token. With a role (migration 0078): that role's field rules, schema policies and limits.
 * Without: its creator's member roles for field rules, and no schema policy (as before phase 4).
 */
export async function principalForToken(db: Kysely<DB>, ctx: Pick<DeveloperApiContext, "workspaceId" | "roleId" | "actorAdminUserId" | "scopes" | "allowedModels" | "agentIdentityId">): Promise<Principal> {
  // Fail closed: a token whose role cannot be found, or that has no role and no ACTIVE creator
  // (suspended, removed, or never set), reads nothing. Otherwise "no role rows" would mean "every
  // field readable".
  const nothing: Principal = {
    workspaceId: ctx.workspaceId, kind: ctx.agentIdentityId ? "agent" : "token", roleIds: [], roleKeys: [],
    scopes: new Set(), allowedModels: null, applyModelPolicy: true,
  };
  let roles: RoleRow[];
  if (ctx.roleId) {
    roles = await db.selectFrom("roles").select(["id", "key", "api_limits"]).where("id", "=", ctx.roleId).where("workspace_id", "=", ctx.workspaceId).execute();
    if (!roles.length) return nothing;
  } else {
    const creatorRoles = ctx.actorAdminUserId ? await memberRoles(db, ctx.workspaceId, ctx.actorAdminUserId) : null;
    if (!creatorRoles) return nothing;
    roles = creatorRoles;
  }
  return {
    workspaceId: ctx.workspaceId,
    kind: ctx.agentIdentityId ? "agent" : "token",
    roleIds: roles.map((role) => role.id),
    roleKeys: roles.map((role) => role.key),
    scopes: new Set(ctx.scopes),
    allowedModels: ctx.allowedModels.length ? ctx.allowedModels : null,
    applyModelPolicy: Boolean(ctx.roleId),
    limitOverrides: limitsOf(roles),
  };
}

/** An admin acting through a side channel (preview issuer, scheduler, webhook owner). Null when not an active member. */
/**
 * `grantedScopes`: model-level grants the channel itself carries (a preview token is the grant to view
 * its entry); field rules still come from the admin's roles.
 */
export async function principalForAdmin(db: Kysely<DB>, workspaceId: string, adminUserId: string, kind: PrincipalKind, grantedScopes: readonly string[] = []): Promise<Principal | null> {
  const roles = await memberRoles(db, workspaceId, adminUserId);
  if (!roles) return null;
  const permissions = roles.length
    ? await db.selectFrom("role_permissions").select("permission_key").distinct().where("role_id", "in", roles.map((role) => role.id)).execute()
    : [];
  return {
    workspaceId,
    kind,
    roleIds: roles.map((role) => role.id),
    roleKeys: roles.map((role) => role.key),
    scopes: new Set([...permissions.map((row) => row.permission_key), ...grantedScopes]),
    allowedModels: null,
    applyModelPolicy: grantedScopes.length === 0,
    limitOverrides: limitsOf(roles),
  };
}

export interface PreviewScope {
  workspaceId: string;
  /** The entries the token previews: its entry, or its release's entries. */
  entryIds: string[];
  issuer: string | null;
}

/** A live (not expired, not revoked) entry or release preview token, by its SHA-256 hash only. */
export async function previewScope(db: Kysely<DB>, rawToken: string): Promise<PreviewScope | null> {
  if (!rawToken || rawToken.length > 200) return null;
  // Same SHA-256 as hashPreviewToken (lib/content/previewService.ts); not imported to keep this module free of the preview service.
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const row = await db.selectFrom("preview_tokens").select(["id", "workspace_id", "entry_id", "release_id", "created_by"])
    .where("token_hash", "=", tokenHash).where("revoked_at", "is", null).where("expires_at", ">", new Date().toISOString())
    .executeTakeFirst();
  if (!row) return null;
  let entryIds: string[] = row.entry_id ? [row.entry_id] : [];
  if (row.release_id) {
    const items = await db.selectFrom("release_items").select("entry_id").where("release_id", "=", row.release_id).limit(1_000).execute();
    entryIds = [...new Set([...entryIds, ...items.map((item) => item.entry_id).filter((id): id is string => Boolean(id))])];
  }
  return { workspaceId: row.workspace_id, entryIds, issuer: row.created_by };
}
