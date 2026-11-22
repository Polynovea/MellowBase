import type { User } from "@supabase/supabase-js";
import type { AdminUser } from "@/lib/admin/types";

// Resolves the admin profile for an authenticated identity.
//
// Profiles are bound to the identity's immutable auth user ID. Email is mutable (users can change it, and
// some providers let anyone claim an unverified address), so it is never enough on its own. The only email
// path is a one-time link for legacy profiles created before auth_user_id was recorded: the profile must
// have no auth_user_id yet and the identity's email must be confirmed. The link is written with a
// compare-and-set so two identities cannot both claim the same legacy profile.

export interface AdminProfileStore {
  findActiveByAuthUserId(authUserId: string): Promise<AdminUser | null>;
  findActiveUnlinkedByEmail(email: string): Promise<AdminUser | null>;
  /** Sets auth_user_id only if it is still null; returns the updated profile or null if someone else won. */
  linkAuthUser(profileId: string, authUserId: string): Promise<AdminUser | null>;
}

export async function resolveAdminProfile(store: AdminProfileStore, user: Pick<User, "id" | "email" | "email_confirmed_at">): Promise<AdminUser | null> {
  const bound = await store.findActiveByAuthUserId(user.id);
  if (bound) return bound;

  const email = user.email?.trim().toLowerCase();
  if (!email || !user.email_confirmed_at) return null;
  const legacy = await store.findActiveUnlinkedByEmail(email);
  if (!legacy) return null;
  return store.linkAuthUser(legacy.id, user.id);
}

type Db = { from(table: "admin_users"): any };

export function supabaseAdminProfileStore(db: Db): AdminProfileStore {
  return {
    async findActiveByAuthUserId(authUserId) {
      const { data, error } = await db.from("admin_users").select("*").eq("auth_user_id", authUserId).eq("is_active", true).maybeSingle();
      if (error) throw error;
      return (data as AdminUser | null) ?? null;
    },
    async findActiveUnlinkedByEmail(email) {
      const { data, error } = await db.from("admin_users").select("*").eq("email", email).is("auth_user_id", null).eq("is_active", true).maybeSingle();
      if (error) throw error;
      return (data as AdminUser | null) ?? null;
    },
    async linkAuthUser(profileId, authUserId) {
      const { data, error } = await db.from("admin_users").update({ auth_user_id: authUserId }).eq("id", profileId).is("auth_user_id", null).select("*").maybeSingle();
      if (error) throw error;
      return (data as AdminUser | null) ?? null;
    },
  };
}
