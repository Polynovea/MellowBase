/**
 * Managed provisioning for new identities, the built-in auth's replacement for migration 0065's
 * `cms_managed_auth_user_created` trigger on `auth.users`.
 *
 * When an install turns provisioning on (`cms_auth_provisioning.enabled`), every new identity gets a
 * viewer profile in the configured workspace, exactly as the trigger did: never from user metadata,
 * never by claiming an existing profile by email, and never as an owner. With the built-in auth there
 * is no `auth.users` table to hang a trigger on, so the auth library's user-creation hook calls this
 * instead (see lib/auth/betterAuth/server.ts). Supabase installs keep the trigger until clean-up.
 *
 * It runs in one transaction, so a profile never exists without its membership and role.
 */
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { withTransaction } from "@/lib/db/index";

export interface NewIdentity {
  id: string;
  email: string | null;
}

/** Returns the new profile ID, or null when provisioning is off or not needed. */
export async function provisionManagedIdentity(identity: NewIdentity, run: typeof withTransaction = withTransaction): Promise<string | null> {
  const email = identity.email?.trim().toLowerCase();
  if (!email) return null;

  return run(async (trx: Kysely<DB>) => {
    const settings = await trx
      .selectFrom("cms_auth_provisioning")
      .select("workspace_slug")
      .where("singleton", "=", true)
      .where("enabled", "=", true)
      .executeTakeFirst();
    if (!settings) return null;

    // Admin-created users get their real profile from the admin user service; the trigger never
    // ran twice for one identity either.
    const existing = await trx.selectFrom("admin_users").select("id").where("auth_user_id", "=", identity.id).executeTakeFirst();
    if (existing) return null;

    const target = await trx
      .selectFrom("workspaces as w")
      .innerJoin("roles as r", (join) => join.onRef("r.workspace_id", "=", "w.id").on("r.key", "=", "viewer").on("r.is_system", "=", true))
      .select(["w.id as workspaceId", "r.id as roleId"])
      .where("w.slug", "=", settings.workspace_slug)
      .where("w.status", "=", "active")
      .executeTakeFirst();
    if (!target) throw new Error("CMS provisioning requires an active workspace and its viewer role");

    const profile = await trx
      .insertInto("admin_users")
      .values({
        auth_user_id: identity.id,
        username: `user_${identity.id.replace(/-/g, "")}`,
        email,
        display_name: email.split("@")[0],
        role: "viewer",
        is_active: true,
        surface_access: ["cms", "content"],
        module_access: ["*"],
        module_write_access: [],
        created_by: "builtin:user-created",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const member = await trx
      .insertInto("workspace_members")
      .values({ workspace_id: target.workspaceId, admin_user_id: profile.id, status: "active" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx.insertInto("member_roles").values({ workspace_member_id: member.id, role_id: target.roleId }).execute();
    return profile.id;
  });
}
