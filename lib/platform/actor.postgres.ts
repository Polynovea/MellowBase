// Direct PostgreSQL implementation of the platform area: workspace lookup and the CMS actor
// (permission) resolver (phase 1, wave 1).
//
// Same signatures and return shapes as actor.supabase.ts. resolveActor is the one place that reads
// workspace membership, roles and permissions (ADR-018), so it stays fail-closed: no active
// membership means no actor, and a role contributes keys and permissions only when it belongs to
// the same workspace. The Supabase path trusted member_roles.role_id without checking the role's
// workspace; a row pointing at another workspace's role now grants nothing.
// A database failure throws (the request fails) instead of being read as "no roles".
import type { AdminUser } from "@/lib/admin/types";
import { DEFAULT_LIST_LIMIT, getDb, maybeOne } from "@/lib/db/index";
import type { WorkspaceCollaborator, WorkspaceRole } from "@/lib/platform/actor.supabase";
import type { CmsActor, Workspace } from "@/lib/platform/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
const asWorkspace = (row: unknown) => row as Workspace;

/**
 * Phase 1 is single-workspace. This resolves the one seeded "polynovea"
 * workspace by slug rather than hardcoding its id anywhere.
 */
export async function getDefaultWorkspace(): Promise<Workspace> {
  const row = maybeOne(await getDb().selectFrom("workspaces").selectAll().where("slug", "=", "polynovea").execute());
  if (!row) {
    throw new Error("Default workspace not found — has supabase/migrations/0007_workspace_core.sql been applied?");
  }
  return asWorkspace(row);
}

export async function getWorkspaceById(workspaceId: string): Promise<Workspace | null> {
  if (!isUuid(workspaceId)) return null;
  const row = maybeOne(await getDb().selectFrom("workspaces").selectAll().where("id", "=", workspaceId).execute());
  return row ? asWorkspace(row) : null;
}

/**
 * Resolves an authenticated CMS actor for one admin identity within one workspace. Every identity,
 * including the first owner, needs an admin_users row and active workspace membership.
 */
export async function resolveActor(
  adminUser: Pick<AdminUser, "id" | "email">,
  workspace: Workspace,
): Promise<CmsActor | null> {
  if (!isUuid(adminUser.id) || !isUuid(workspace.id)) return null;
  const db = getDb();

  const member = maybeOne(await db
    .selectFrom("workspace_members")
    .select(["id", "status"])
    .where("workspace_id", "=", workspace.id)
    .where("admin_user_id", "=", adminUser.id)
    .execute());
  if (!member || member.status !== "active") return null;

  const roles = await db
    .selectFrom("member_roles as mr")
    .innerJoin("roles as r", "r.id", "mr.role_id")
    .select(["r.id", "r.key"])
    .where("mr.workspace_member_id", "=", member.id)
    .where("r.workspace_id", "=", workspace.id)
    .orderBy("r.key")
    .execute();

  const roleIds = roles.map((role) => role.id);
  const permissions = new Set<string>();
  if (roleIds.length) {
    const rows = await db
      .selectFrom("role_permissions")
      .select("permission_key")
      .distinct()
      .where("role_id", "in", roleIds)
      .execute();
    for (const row of rows) permissions.add(row.permission_key);
  }

  return {
    adminUserId: adminUser.id,
    workspaceId: workspace.id,
    workspaceMemberId: member.id,
    roleKeys: roles.map((role) => role.key),
    permissions,
    isMasterBypass: false,
  };
}

/** A workspace's assignable roles (key, name, description only). */
export async function listWorkspaceRoles(workspaceId: string): Promise<WorkspaceRole[]> {
  if (!isUuid(workspaceId)) return [];
  return getDb()
    .selectFrom("roles")
    .select(["key", "name", "description"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("name", "asc")
    .limit(DEFAULT_LIST_LIMIT)
    .execute();
}

export async function listWorkspaceCollaborators(workspaceId: string): Promise<WorkspaceCollaborator[]> {
  if (!isUuid(workspaceId)) return [];
  const rows = await getDb()
    .selectFrom("workspace_members as m")
    .innerJoin("admin_users as u", "u.id", "m.admin_user_id")
    .select(["u.id", "u.display_name", "u.email"])
    .where("m.workspace_id", "=", workspaceId)
    .where("m.status", "=", "active")
    .orderBy("u.email")
    .limit(DEFAULT_LIST_LIMIT)
    .execute();
  return rows.map((user) => ({ id: user.id, displayName: user.display_name || user.email, email: user.email }));
}
