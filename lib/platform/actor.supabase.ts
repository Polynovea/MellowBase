// Supabase path of the platform area (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import type { AdminUser } from "@/lib/admin/types";
import type { CmsActor, Workspace } from "@/lib/platform/types";

// Query errors throw, as on the direct path: a database failure fails the request instead of reading
// as "no workspace", "no roles" or "no permissions". Malformed IDs are answered before the query
// (PostgREST would report them as an error) the same way the direct path answers them.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
function check(error: { message: string } | null, what: string): void {
  if (error) throw Object.assign(new Error(`Could not read ${what}`), { cause: error });
}

/**
 * Phase 1 is single-workspace. This resolves the one seeded "polynovea"
 * workspace by slug rather than hardcoding its id anywhere. Multi-workspace
 * selection (per-request workspace context) is Phase 2+ scope.
 */
export async function getDefaultWorkspace(): Promise<Workspace> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("workspaces")
    .select("*")
    .eq("slug", "polynovea")
    .single();

  if (error || !data) {
    throw new Error(
      "Default workspace not found — has supabase/migrations/0007_workspace_core.sql been applied?",
    );
  }
  return data as Workspace;
}

export async function getWorkspaceById(workspaceId: string): Promise<Workspace | null> {
  if (!isUuid(workspaceId)) return null;
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .maybeSingle();
  check(error, "workspace");

  return (data as Workspace) ?? null;
}

/**
 * Resolves an authenticated CMS actor for one admin identity within one
 * workspace. This is the one place that reads workspace_members/
 * member_roles/roles/role_permissions — nothing else should query those
 * tables directly (see ADR-018, which supersedes ADR-013).
 *
 * Every identity, including the first owner/master, must have an auditable
 * admin_users row and active workspace membership. First-admin setup is
 * performed by the server-only bootstrap command rather than a code bypass.
 */
export async function resolveActor(
  adminUser: Pick<AdminUser, "id" | "email">,
  workspace: Workspace,
): Promise<CmsActor | null> {
  if (!isUuid(adminUser.id) || !isUuid(workspace.id)) return null;
  const db = createServiceRoleClient();

  const { data: member, error: memberError } = await db
    .from("workspace_members")
    .select("id, status")
    .eq("workspace_id", workspace.id)
    .eq("admin_user_id", adminUser.id)
    .maybeSingle();

  check(memberError, "workspace membership");
  if (!member || member.status !== "active") {
    return null;
  }

  // Only roles of this workspace count: member_roles.role_id is not tied to a workspace, so a row
  // pointing at another workspace's role must grant nothing.
  const { data: roleRows, error: roleError } = await db
    .from("member_roles")
    .select("role_id, roles!inner(key, workspace_id)")
    .eq("workspace_member_id", member.id)
    .eq("roles.workspace_id", workspace.id);
  check(roleError, "member roles");

  const roleIds = (roleRows ?? []).map((row: { role_id: string }) => row.role_id);
  const roleKeys = (roleRows ?? [])
    .map((row: { roles: { key: string } | { key: string }[] | null }) =>
      Array.isArray(row.roles) ? row.roles[0]?.key : row.roles?.key,
    )
    .filter((key): key is string => Boolean(key));

  if (roleIds.length === 0) {
    return {
      adminUserId: adminUser.id,
      workspaceId: workspace.id,
      workspaceMemberId: member.id,
      roleKeys: [],
      permissions: new Set(),
      isMasterBypass: false,
    };
  }

  const { data: permissionRows, error: permissionError } = await db
    .from("role_permissions")
    .select("permission_key")
    .in("role_id", roleIds);
  check(permissionError, "role permissions");

  const permissions = new Set(
    (permissionRows ?? []).map((row: { permission_key: string }) => row.permission_key),
  );

  return {
    adminUserId: adminUser.id,
    workspaceId: workspace.id,
    workspaceMemberId: member.id,
    roleKeys,
    permissions,
    isMasterBypass: false,
  };
}

export interface WorkspaceRole {
  key: string;
  name: string;
  description: string | null;
}

/**
 * Lists a workspace's assignable roles (key/name/description only — no
 * membership or permission data). Used by the Visual Database Studio's
 * per-model permission-policy editor (ADR-016) so a schema author picks
 * from real role keys instead of typing free text that could drift from
 * what `resolveActor` actually grants.
 */
export async function listWorkspaceRoles(workspaceId: string): Promise<WorkspaceRole[]> {
  if (!isUuid(workspaceId)) return [];
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("roles")
    .select("key, name, description")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });
  check(error, "workspace roles");
  return data ?? [];
}

export interface WorkspaceCollaborator { id: string; displayName: string; email: string; }
export async function listWorkspaceCollaborators(workspaceId: string): Promise<WorkspaceCollaborator[]> {
  if (!isUuid(workspaceId)) return [];
  const { data, error } = await createServiceRoleClient().from("workspace_members").select("admin_user_id, admin_users(id, display_name, email)").eq("workspace_id", workspaceId).eq("status", "active");
  check(error, "workspace collaborators");
  return (data ?? []).flatMap((row: { admin_users: { id: string; display_name: string | null; email: string } | { id: string; display_name: string | null; email: string }[] | null }) => {
    const user = Array.isArray(row.admin_users) ? row.admin_users[0] : row.admin_users;
    return user ? [{ id: user.id, displayName: user.display_name || user.email, email: user.email }] : [];
  });
}
