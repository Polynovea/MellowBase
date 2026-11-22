// Supabase path of the admin user profile writes (moved from app/api/admin/users/*, app/api/admin/me;
// deleted with the switch at the end of phase 1). The identity-provider calls (GoTrue) stay in the
// routes; these functions keep the old sequence and its compensating deletes.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { syncDefaultWorkspaceMembership } from "@/lib/admin/workspaceMembership";
import type { AdminActivityLog } from "@/lib/admin/types";
import type { AdminProfilePatch, NewAdminProfile } from "@/lib/admin/adminUserService";

/* eslint-disable @typescript-eslint/no-explicit-any -- profile rows are normalized by the routes */
export async function listAdminUsersWithActivity(): Promise<{ users: any[]; activity: AdminActivityLog[] }> {
  const db = createServiceRoleClient();
  const { data, error } = await db.from("admin_users").select("*").order("role", { ascending: true }).order("username", { ascending: true });
  const { data: activityRows } = await db.from("admin_activity_log").select("*").order("created_at", { ascending: false }).limit(12);
  if (error) throw error;
  return { users: data ?? [], activity: (activityRows ?? []) as AdminActivityLog[] };
}

export async function findAdminUser(id: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("admin_users").select("*").eq("id", id).single();
  if (error || !data) return null;
  return data;
}

export async function findProfileIdByAuthUserId(authUserId: string): Promise<string | null> {
  const { data, error } = await createServiceRoleClient().from("admin_users").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Creates the profile (or takes over the one the auth trigger provisioned) and its default workspace
 * membership. On failure it removes what it wrote and throws; the route then deletes the auth user.
 */
export async function createAdminProfile(params: { payload: NewAdminProfile; provisionedId: string | null }): Promise<any> {
  const db = createServiceRoleClient();
  const profileMutation = params.provisionedId
    ? db.from("admin_users").update(params.payload).eq("id", params.provisionedId)
    : db.from("admin_users").insert(params.payload);
  const { data, error } = await profileMutation.select("*").single();
  if (error) {
    if (params.provisionedId) await db.from("admin_users").delete().eq("id", params.provisionedId);
    throw error;
  }
  try {
    await syncDefaultWorkspaceMembership(data as any, db);
  } catch (membershipError) {
    await db.from("admin_users").delete().eq("id", data.id);
    throw Object.assign(new Error((membershipError as Error)?.message || "Failed to create workspace membership"), { stage: "membership" });
  }
  return data;
}

/** Updates the profile, then re-syncs its default workspace membership. */
export async function updateAdminProfile(id: string, patch: AdminProfilePatch): Promise<any> {
  const db = createServiceRoleClient();
  const { data, error } = await db.from("admin_users").update(patch).eq("id", id).select("*").single();
  if (error) throw error;
  try {
    await syncDefaultWorkspaceMembership(data as any, db);
  } catch (membershipError) {
    throw Object.assign(new Error((membershipError as Error)?.message || "Failed to synchronize workspace membership"), { stage: "membership" });
  }
  return data;
}

export async function updateOwnDisplayName(id: string, displayName: string): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("admin_users").update({ display_name: displayName, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (error || !data) throw error ?? new Error("Could not update profile");
  return data;
}

export async function deleteAdminProfile(id: string): Promise<void> {
  const { error } = await createServiceRoleClient().from("admin_users").delete().eq("id", id);
  if (error) throw error;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
