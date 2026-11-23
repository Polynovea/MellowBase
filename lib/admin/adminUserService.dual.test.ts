import { afterEach, describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import {
  createAdminProfile,
  deleteAdminProfile,
  findAdminUser,
  findProfileIdByAuthUserId,
  listAdminUsersWithActivity,
  updateAdminProfile,
  updateOwnDisplayName,
  type NewAdminProfile,
} from "@/lib/admin/adminUserService";

function payload(suffix: string, overrides: Partial<NewAdminProfile> = {}): NewAdminProfile {
  return {
    auth_user_id: crypto.randomUUID(), username: `member-${suffix}`, email: `member-${suffix}@example.test`, display_name: `Member ${suffix}`,
    role: "editor", is_active: true, surface_access: ["cms"], module_access: ["cms.access"], module_write_access: ["cms.access"], created_by: "test",
    ...overrides,
  };
}

async function membership(backend: BackendFixtures, profileId: string) {
  return backend.query<{ status: string; roles: string[] }>(
    `select m.status, coalesce(array_agg(r.key order by r.key) filter (where r.id is not null), '{}') as roles
     from workspace_members m join workspaces w on w.id = m.workspace_id and w.slug = 'polynovea'
     left join member_roles mr on mr.workspace_member_id = m.id left join roles r on r.id = mr.role_id
     where m.admin_user_id = $1 group by m.status`,
    [profileId],
  );
}

describeWithDatabase("admin user profiles", (backend) => {
  afterEach(() => { delete process.env.POLYNOVEA_DEFAULT_WORKSPACE_SLUG; });

  it("creates a profile with its default workspace membership, and updates both together", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createAdminProfile({ payload: payload(suffix), provisionedId: null });
    expect(created).toMatchObject({ username: `member-${suffix}`, role: "editor", is_active: true });
    expect(await membership(backend, created.id)).toEqual([{ status: "active", roles: ["editor"] }]);
    expect(await findProfileIdByAuthUserId(created.auth_user_id)).toBe(created.id);

    // A custom role survives a role change; the system role is replaced.
    const [workspace] = await backend.query<{ id: string }>("select id from workspaces where slug = 'polynovea'");
    const [custom] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, $2, 'Custom') returning id", [workspace.id, `custom-${suffix}`]);
    const [member] = await backend.query<{ id: string }>("select id from workspace_members where workspace_id = $1 and admin_user_id = $2", [workspace.id, created.id]);
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [member.id, custom.id]);

    const updated = await updateAdminProfile(created.id, {
      display_name: "Renamed", role: "admin", is_active: false, surface_access: ["cms", "content"], module_access: ["cms.access"], module_write_access: ["cms.access"], updated_at: new Date().toISOString(),
    });
    expect(updated).toMatchObject({ display_name: "Renamed", role: "admin", is_active: false });
    expect(await membership(backend, created.id)).toEqual([{ status: "suspended", roles: ["admin", `custom-${suffix}`].sort() }]);

    expect((await updateOwnDisplayName(created.id, "Me")).display_name).toBe("Me");
    expect((await findAdminUser(created.id))?.display_name).toBe("Me");
  });

  it("takes over the profile the auth trigger provisioned", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const authId = crypto.randomUUID();
    const [provisioned] = await backend.query<{ id: string }>("insert into admin_users (auth_user_id, username, email, role) values ($1, $2, $3, 'viewer') returning id", [authId, `user_${suffix}`, `p-${suffix}@example.test`]);
    expect(await findProfileIdByAuthUserId(authId)).toBe(provisioned.id);
    const taken = await createAdminProfile({ payload: payload(suffix, { auth_user_id: authId }), provisionedId: provisioned.id });
    expect(taken).toMatchObject({ id: provisioned.id, username: `member-${suffix}`, role: "editor" });
    expect(await membership(backend, provisioned.id)).toEqual([{ status: "active", roles: ["editor"] }]);
  });

  it("leaves no profile behind when the membership cannot be created", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    process.env.POLYNOVEA_DEFAULT_WORKSPACE_SLUG = `missing-${suffix}`;
    const fresh = payload(suffix);
    await expect(createAdminProfile({ payload: fresh, provisionedId: null })).rejects.toThrow(`Default workspace 'missing-${suffix}' not found`);
    expect(await findProfileIdByAuthUserId(fresh.auth_user_id)).toBeNull();

    // A provisioned profile that cannot be taken over is removed (the route deletes its auth user).
    const authId = crypto.randomUUID();
    const [provisioned] = await backend.query<{ id: string }>("insert into admin_users (auth_user_id, username, email) values ($1, $2, $3) returning id", [authId, `prov-${suffix}`, `prov-${suffix}@example.test`]);
    await expect(createAdminProfile({ payload: payload(`${suffix}b`, { auth_user_id: authId }), provisionedId: provisioned.id })).rejects.toThrow();
    expect(await findAdminUser(provisioned.id)).toBeNull();
  });

  it("refuses a duplicate username, deletes profiles and lists them with recent activity", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const created = await createAdminProfile({ payload: payload(suffix), provisionedId: null });
    await expect(createAdminProfile({ payload: payload(suffix), provisionedId: null })).rejects.toThrow();
    const listed = await listAdminUsersWithActivity();
    expect(listed.users.some((user) => user.id === created.id)).toBe(true);
    expect(Array.isArray(listed.activity)).toBe(true);
    await deleteAdminProfile(created.id);
    expect(await findAdminUser(created.id)).toBeNull();
    expect(await membership(backend, created.id)).toEqual([]);
    expect(await findAdminUser("not-a-uuid")).toBeNull();
  });
});
