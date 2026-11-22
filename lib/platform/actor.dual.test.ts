import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { getWorkspaceById, listWorkspaceCollaborators, listWorkspaceRoles, resolveActor } from "@/lib/platform/actor";
import type { Workspace } from "@/lib/platform/types";

// The permission resolver behind every platform route (ADR-018): it must fail closed on both backends.
const recorder = createRecorder();

async function role(backend: BackendFixtures, workspaceId: string, key: string, permissionKeys: string[]) {
  const [row] = await backend.query<{ id: string }>(
    "insert into roles (workspace_id, key, name, description) values ($1, $2, $3, 'Test role') returning id",
    [workspaceId, key, key.toUpperCase()],
  );
  for (const permission of permissionKeys) {
    await backend.query("insert into role_permissions (role_id, permission_key) values ($1, $2)", [row.id, permission]);
  }
  return row.id;
}

async function member(backend: BackendFixtures, workspaceId: string, adminUserId: string, status = "active") {
  const [row] = await backend.query<{ id: string }>(
    "insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, $3) returning id",
    [workspaceId, adminUserId, status],
  );
  return row.id;
}

describeBothBackends("platform", "platform actor resolver", (backend) => {
  async function setup() {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const permissions = (await backend.query<{ key: string }>("select key from permissions order by key limit 3")).map((p) => p.key);
    expect(permissions.length).toBe(3);
    const workspace = (await getWorkspaceById(workspaceId)) as Workspace;
    return { workspaceId, adminUserId, permissions, workspace };
  }

  it("resolves an active member's roles and permissions", async () => {
    const { workspaceId, adminUserId, permissions, workspace } = await setup();
    const memberId = await member(backend, workspaceId, adminUserId);
    const editor = await role(backend, workspaceId, "editor", [permissions[0], permissions[1]]);
    const reviewer = await role(backend, workspaceId, "reviewer", [permissions[1], permissions[2]]);
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2), ($1, $3)", [memberId, editor, reviewer]);

    const actor = await resolveActor({ id: adminUserId, email: "x@example.test" }, workspace);
    expect(actor).toMatchObject({ adminUserId, workspaceId, workspaceMemberId: memberId, isMasterBypass: false });
    expect([...actor!.roleKeys].sort()).toEqual(["editor", "reviewer"]);
    expect([...actor!.permissions].sort()).toEqual([...permissions].sort());
    recorder.record(backend.name, "actor", { ...actor, roleKeys: [...actor!.roleKeys].sort(), permissions: [...actor!.permissions].sort() });
  });

  it("returns an actor with no permissions for a member with no roles", async () => {
    const { workspaceId, adminUserId, workspace } = await setup();
    await member(backend, workspaceId, adminUserId);
    const actor = await resolveActor({ id: adminUserId, email: "x@example.test" }, workspace);
    expect(actor).toMatchObject({ roleKeys: [], isMasterBypass: false });
    expect(actor!.permissions.size).toBe(0);
  });

  it("fails closed for non-members, inactive members and malformed IDs", async () => {
    const { workspaceId, adminUserId, workspace } = await setup();
    expect(await resolveActor({ id: adminUserId, email: "x@example.test" }, workspace)).toBeNull();
    const other = await backend.createWorkspace();
    await member(backend, workspaceId, other.adminUserId, "suspended");
    expect(await resolveActor({ id: other.adminUserId, email: "y@example.test" }, workspace)).toBeNull();
    expect(await resolveActor({ id: "not-a-uuid", email: "z@example.test" }, workspace)).toBeNull();
  });

  it("never grants a role that belongs to another workspace", async () => {
    const { workspaceId, adminUserId, permissions, workspace } = await setup();
    const elsewhere = await backend.createWorkspace();
    const memberId = await member(backend, workspaceId, adminUserId);
    const foreignRole = await role(backend, elsewhere.workspaceId, "owner", permissions);
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [memberId, foreignRole]);
    const actor = await resolveActor({ id: adminUserId, email: "x@example.test" }, workspace);
    expect(actor?.roleKeys).toEqual([]);
    expect(actor?.permissions.size).toBe(0);
  });

  it("lists roles and active collaborators of one workspace only", async () => {
    const { workspaceId, adminUserId, workspace } = await setup();
    await role(backend, workspaceId, "b_role", []);
    await role(backend, workspaceId, "a_role", []);
    const elsewhere = await backend.createWorkspace();
    await role(backend, elsewhere.workspaceId, "foreign", []);
    expect((await listWorkspaceRoles(workspaceId)).map((r) => r.key)).toEqual(["a_role", "b_role"]);
    expect(await listWorkspaceRoles(workspaceId)).toEqual(expect.arrayContaining([{ key: "a_role", name: "A_ROLE", description: "Test role" }]));

    await member(backend, workspaceId, adminUserId);
    const suspended = await backend.createWorkspace();
    await member(backend, workspaceId, suspended.adminUserId, "suspended");
    const collaborators = await listWorkspaceCollaborators(workspaceId);
    expect(collaborators).toEqual([{ id: adminUserId, displayName: expect.any(String), email: expect.stringContaining("@example.test") }]);
    expect(await getWorkspaceById("not-a-uuid")).toBeNull();
    expect(workspace.id).toBe(workspaceId);
    recorder.record(backend.name, "lists", { roles: await listWorkspaceRoles(workspaceId), collaborators: collaborators.map((c) => ({ ...c, displayName: "<random>", email: "<random>" })) });
  });
});

describe("platform actor backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
