// Database writes of `npm run bootstrap:admin` (phase 1, wave 5): make an auth identity the active
// master admin and workspace owner. The script picks the store with the `admin` area of
// POLYNOVEA_DATA_BACKEND, the same switch the app uses for admin profiles.
//
// - supabaseAdminStore: the PostgREST calls the script always made (deleted with the switch).
// - postgresAdminStore: the same writes over a pg client, in one transaction, so a failure never
//   leaves a master admin with no membership or a membership with its system roles removed and no
//   owner role yet.
//
// The auth identity comes from Supabase Auth, or with AUTH_PROVIDER=builtin from
// lib/auth/bootstrapOwner.mjs, which also owns the PostgreSQL rows used here (grantOwnerRows).

import { grantOwnerRows } from "../../lib/auth/bootstrapOwner.mjs";

const MASTER_ACCESS = { role: "master", is_active: true, surface_access: ["cms", "content"], module_access: ["*"], module_write_access: ["*"] };

/**
 * The backend the `admin` area uses, read the way lib/db/backend.ts reads POLYNOVEA_DATA_BACKEND: a
 * bare value sets the default, `admin=value` overrides it. Unknown values are an error.
 */
export function adminBackend(raw) {
  let backend = "supabase";
  for (const part of String(raw ?? "").split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const [area, value] = token.includes("=") ? token.split("=", 2).map((item) => item.trim()) : [null, token];
    if (value !== "supabase" && value !== "postgres") throw new Error(`POLYNOVEA_DATA_BACKEND: unknown backend ${JSON.stringify(value)}`);
    if (area === null || area === "admin") backend = value;
  }
  return backend;
}

/** @param {import("@supabase/supabase-js").SupabaseClient} client */
export function supabaseAdminStore(client) {
  return {
    async grantOwner({ authUserId, email, username, displayName, workspaceSlug }) {
      const { data: existing, error: existingError } = await client.from("admin_users").select("*").eq("email", email).maybeSingle();
      if (existingError) throw existingError;

      let adminUser;
      if (existing) {
        const { data, error } = await client.from("admin_users")
          .update({ auth_user_id: authUserId, username, display_name: displayName, ...MASTER_ACCESS, updated_at: new Date().toISOString() })
          .eq("id", existing.id).select("*").single();
        if (error) throw error;
        adminUser = data;
      } else {
        const { data, error } = await client.from("admin_users")
          .insert({ auth_user_id: authUserId, username, email, display_name: displayName, ...MASTER_ACCESS, created_by: "bootstrap:admin" })
          .select("*").single();
        if (error) throw error;
        adminUser = data;
      }

      const { data: workspace, error: workspaceError } = await client.from("workspaces").select("id, slug").eq("slug", workspaceSlug).single();
      if (workspaceError || !workspace) throw workspaceError || new Error(`Workspace '${workspaceSlug}' does not exist. Apply migrations before bootstrapping the first admin.`);

      const { data: member, error: memberError } = await client.from("workspace_members")
        .upsert({ workspace_id: workspace.id, admin_user_id: adminUser.id, status: "active", updated_at: new Date().toISOString() }, { onConflict: "workspace_id,admin_user_id" })
        .select("id").single();
      if (memberError || !member) throw memberError || new Error("Failed to create workspace membership.");

      const { data: ownerRole, error: roleError } = await client.from("roles").select("id").eq("workspace_id", workspace.id).eq("key", "owner").single();
      if (roleError || !ownerRole) throw roleError || new Error("Default owner role is missing. Apply workspace migrations first.");

      const { data: systemRoles, error: systemRoleError } = await client.from("roles").select("id").eq("workspace_id", workspace.id).eq("is_system", true);
      if (systemRoleError) throw systemRoleError;
      const systemRoleIds = (systemRoles || []).map((role) => role.id);
      if (systemRoleIds.length) {
        const { error } = await client.from("member_roles").delete().eq("workspace_member_id", member.id).in("role_id", systemRoleIds);
        if (error) throw error;
      }

      const { error: memberRoleError } = await client.from("member_roles").upsert({ workspace_member_id: member.id, role_id: ownerRole.id }, { onConflict: "workspace_member_id,role_id" });
      if (memberRoleError) throw memberRoleError;
      return { adminUserId: adminUser.id, workspaceId: workspace.id, memberId: member.id };
    },
  };
}

/** @param {import("pg").Client} client a connected client; the store runs one transaction on it */
export function postgresAdminStore(client) {
  return {
    async grantOwner(details) {
      await client.query("begin");
      try {
        const granted = await grantOwnerRows(client, details);
        await client.query("commit");
        return granted;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    },
  };
}
