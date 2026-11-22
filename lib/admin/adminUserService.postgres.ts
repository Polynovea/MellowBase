// Direct PostgreSQL path of the admin user profile writes (phase 1, wave 2).
//
// Same signatures and return shapes as adminUserService.supabase.ts. Differences that are deliberate:
// - Creating or updating a profile and syncing its default workspace membership (membership row,
//   system role) run in one transaction. The Supabase path wrote them one by one and, when the
//   membership failed, deleted the profile again; here nothing is left half-written. The one
//   compensation kept is the auth trigger's provisioned viewer profile, which existed before the
//   request: if taking it over fails, it is removed, as before, because the route deletes its auth user.
// - Membership errors carry fixed messages, never database text.
// - Lists have explicit limits and tie-breaks; malformed IDs are "not found".
import { DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction, type DbExecutor } from "@/lib/db/index";
import type { AdminActivityLog, AdminRole } from "@/lib/admin/types";
import type { AdminProfilePatch, NewAdminProfile } from "@/lib/admin/adminUserService";

/* eslint-disable @typescript-eslint/no-explicit-any -- profile rows are normalized by the routes */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

const ROLE_TO_WORKSPACE_ROLE: Record<AdminRole, "owner" | "admin" | "editor" | "viewer"> = {
  master: "owner",
  admin: "admin",
  editor: "editor",
  viewer: "viewer",
};

class MembershipError extends Error {
  readonly stage = "membership";
}

/**
 * Same rules as syncDefaultWorkspaceMembership (lib/admin/workspaceMembership.ts): the profile is a
 * member of the default workspace (active or suspended with the profile), and its one system role
 * follows the profile's global role; custom roles are left alone.
 */
async function syncMembership(trx: DbExecutor, profile: { id: string; role: AdminRole; is_active: boolean }) {
  const workspaceSlug = process.env.POLYNOVEA_DEFAULT_WORKSPACE_SLUG?.trim().toLowerCase() || "polynovea";
  const workspace = maybeOne(await trx.selectFrom("workspaces").select("id").where("slug", "=", workspaceSlug).execute());
  if (!workspace) throw new MembershipError(`Default workspace '${workspaceSlug}' not found`);

  const member = expectOne(await trx.insertInto("workspace_members")
    .values({ workspace_id: workspace.id, admin_user_id: profile.id, status: profile.is_active ? "active" : "suspended", updated_at: new Date().toISOString() })
    .onConflict((conflict) => conflict.columns(["workspace_id", "admin_user_id"]).doUpdateSet((eb) => ({ status: eb.ref("excluded.status"), updated_at: eb.ref("excluded.updated_at") })))
    .returning("id").execute(), "Failed to synchronize workspace membership");

  const systemRoles = await trx.selectFrom("roles").select(["id", "key"]).where("workspace_id", "=", workspace.id).where("is_system", "=", true).execute();
  const targetKey = ROLE_TO_WORKSPACE_ROLE[profile.role];
  const target = systemRoles.find((role) => role.key === targetKey);
  if (!target) throw new MembershipError(`Default workspace role '${targetKey}' not found`);

  if (systemRoles.length) {
    await trx.deleteFrom("member_roles").where("workspace_member_id", "=", member.id).where("role_id", "in", systemRoles.map((role) => role.id)).execute();
  }
  await trx.insertInto("member_roles").values({ workspace_member_id: member.id, role_id: target.id })
    .onConflict((conflict) => conflict.columns(["workspace_member_id", "role_id"]).doNothing()).execute();
}

export async function listAdminUsersWithActivity(): Promise<{ users: any[]; activity: AdminActivityLog[] }> {
  const db = getDb();
  const [users, activity] = await Promise.all([
    db.selectFrom("admin_users").selectAll().orderBy("role", "asc").orderBy("username", "asc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("admin_activity_log").selectAll().orderBy("created_at", "desc").orderBy("id", "desc").limit(12).execute(),
  ]);
  return { users, activity: activity as unknown as AdminActivityLog[] };
}

export async function findAdminUser(id: string): Promise<any | null> {
  if (!isUuid(id)) return null;
  return maybeOne(await getDb().selectFrom("admin_users").selectAll().where("id", "=", id).execute());
}

export async function findProfileIdByAuthUserId(authUserId: string): Promise<string | null> {
  if (!isUuid(authUserId)) return null;
  const row = maybeOne(await getDb().selectFrom("admin_users").select("id").where("auth_user_id", "=", authUserId).execute());
  return row?.id ?? null;
}

export async function createAdminProfile(params: { payload: NewAdminProfile; provisionedId: string | null }): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const profile = params.provisionedId
        ? expectOne(await trx.updateTable("admin_users").set(params.payload).where("id", "=", params.provisionedId).returningAll().execute(), "Could not create the member profile")
        : expectOne(await trx.insertInto("admin_users").values(params.payload).returningAll().execute(), "Could not create the member profile");
      await syncMembership(trx, profile as any);
      return profile;
    });
  } catch (error) {
    if (params.provisionedId) await getDb().deleteFrom("admin_users").where("id", "=", params.provisionedId).execute().catch(() => undefined);
    throw error;
  }
}

export async function updateAdminProfile(id: string, patch: AdminProfilePatch): Promise<any> {
  if (!isUuid(id)) throw new Error("User profile not found");
  return withTransaction(async (trx) => {
    const profile = expectOne(await trx.updateTable("admin_users").set(patch).where("id", "=", id).returningAll().execute(), "User profile not found");
    await syncMembership(trx, profile as any);
    return profile;
  });
}

export async function updateOwnDisplayName(id: string, displayName: string): Promise<any> {
  return expectOne(await getDb().updateTable("admin_users").set({ display_name: displayName, updated_at: new Date().toISOString() })
    .where("id", "=", id).returningAll().execute(), "Could not update profile");
}

export async function deleteAdminProfile(id: string): Promise<void> {
  if (!isUuid(id)) throw new Error("User profile not found");
  await getDb().deleteFrom("admin_users").where("id", "=", id).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
