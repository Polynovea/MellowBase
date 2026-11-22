import type { User } from "@/lib/auth/provider";
import type { AdminUser } from "@/lib/admin/types";
import { getDb, maybeOne } from "@/lib/db/index";

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

export async function resolveAdminProfile(store: AdminProfileStore, user: Pick<User, "id" | "email" | "emailConfirmedAt">): Promise<AdminUser | null> {
  const bound = await store.findActiveByAuthUserId(user.id);
  if (bound) return bound;

  const email = user.email?.trim().toLowerCase();
  if (!email || !user.emailConfirmedAt) return null;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Direct PostgreSQL store with the same rules: strict single rows, compare-and-set link. */
export function postgresAdminProfileStore(): AdminProfileStore {
  const asProfile = (row: unknown) => (row ?? null) as AdminUser | null;
  return {
    async findActiveByAuthUserId(authUserId) {
      if (!UUID.test(authUserId)) return null;
      return asProfile(maybeOne(await getDb().selectFrom("admin_users").selectAll()
        .where("auth_user_id", "=", authUserId).where("is_active", "=", true).execute()));
    },
    async findActiveUnlinkedByEmail(email) {
      return asProfile(maybeOne(await getDb().selectFrom("admin_users").selectAll()
        .where("email", "=", email).where("auth_user_id", "is", null).where("is_active", "=", true).execute()));
    },
    async linkAuthUser(profileId, authUserId) {
      if (!UUID.test(profileId) || !UUID.test(authUserId)) return null;
      return asProfile(maybeOne(await getDb().updateTable("admin_users").set({ auth_user_id: authUserId })
        .where("id", "=", profileId).where("auth_user_id", "is", null).returningAll().execute()));
    },
  };
}
