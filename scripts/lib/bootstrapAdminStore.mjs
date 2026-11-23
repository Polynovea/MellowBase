// Database writes of `npm run bootstrap:admin` (phase 1, wave 5): make an auth identity the active
// master admin and workspace owner. The script picks the store with the `admin` area of
// POLYNOVEA_DATA_BACKEND, the same switch the app uses for admin profiles.
//
// - supabaseAdminStore: the PostgREST calls the script always made (deleted with the switch).
// - postgresAdminStore: the same writes over a pg client, in one transaction, so a failure never
//   leaves a master admin with no membership or a membership with its system roles removed and no
//   owner role yet.
//
// Creating the auth identity itself stays with Supabase Auth until the built-in auth workstream.

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
    async grantOwner({ authUserId, email, username, displayName, workspaceSlug }) {
      await client.query("begin");
      try {
        const existing = await client.query("select id from admin_users where email = $1 order by id limit 2 for update", [email]);
        if (existing.rows.length > 1) throw new Error(`More than one admin user has the email ${email}. Resolve the duplicate before bootstrapping.`);
        const access = [MASTER_ACCESS.role, MASTER_ACCESS.is_active, MASTER_ACCESS.surface_access, MASTER_ACCESS.module_access, MASTER_ACCESS.module_write_access];
        const adminUser = existing.rows.length
          ? (await client.query(
            "update admin_users set auth_user_id = $2, username = $3, display_name = $4, role = $5, is_active = $6, surface_access = $7, module_access = $8, module_write_access = $9, updated_at = now() where id = $1 returning id",
            [existing.rows[0].id, authUserId, username, displayName, ...access],
          )).rows[0]
          : (await client.query(
            "insert into admin_users (auth_user_id, username, email, display_name, role, is_active, surface_access, module_access, module_write_access, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bootstrap:admin') returning id",
            [authUserId, username, email, displayName, ...access],
          )).rows[0];

        const workspace = (await client.query("select id from workspaces where slug = $1", [workspaceSlug])).rows[0];
        if (!workspace) throw new Error(`Workspace '${workspaceSlug}' does not exist. Apply migrations before bootstrapping the first admin.`);

        const member = (await client.query(
          "insert into workspace_members (workspace_id, admin_user_id, status, updated_at) values ($1, $2, 'active', now()) on conflict (workspace_id, admin_user_id) do update set status = 'active', updated_at = now() returning id",
          [workspace.id, adminUser.id],
        )).rows[0];

        const ownerRole = (await client.query("select id from roles where workspace_id = $1 and key = 'owner'", [workspace.id])).rows[0];
        if (!ownerRole) throw new Error("Default owner role is missing. Apply workspace migrations first.");

        await client.query("delete from member_roles where workspace_member_id = $1 and role_id in (select id from roles where workspace_id = $2 and is_system)", [member.id, workspace.id]);
        await client.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2) on conflict (workspace_member_id, role_id) do nothing", [member.id, ownerRole.id]);
        await client.query("commit");
        return { adminUserId: adminUser.id, workspaceId: workspace.id, memberId: member.id };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    },
  };
}
