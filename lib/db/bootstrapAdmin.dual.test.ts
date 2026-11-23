import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { poolConfigFromEnv } from "@/lib/db/pool";
import { adminBackend, postgresAdminStore, supabaseAdminStore } from "../../scripts/lib/bootstrapAdminStore.mjs";

const recorder = createRecorder();
const clients: pg.Client[] = [];
afterAll(async () => { await Promise.all(clients.map((client) => client.end())); });

async function storeFor(backend: BackendFixtures) {
  if (backend.name === "supabase") return supabaseAdminStore(createServiceRoleClient());
  // The app's own runtime connection, as the script makes it from POLYNOVEA_DATABASE_URL / DATABASE_URL.
  const client = new pg.Client(poolConfigFromEnv(process.env));
  await client.connect();
  clients.push(client);
  return postgresAdminStore(client);
}

async function workspaceWithRoles(backend: BackendFixtures) {
  const { workspaceId } = await backend.createWorkspace();
  const [workspace] = await backend.query<{ slug: string }>("select slug from workspaces where id = $1", [workspaceId]);
  const [owner] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name, is_system) values ($1, 'owner', 'Owner', true) returning id", [workspaceId]);
  const [editor] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name, is_system) values ($1, 'editor', 'Editor', true) returning id", [workspaceId]);
  return { workspaceId, slug: workspace.slug, ownerRoleId: owner.id, editorRoleId: editor.id };
}

describe("bootstrap admin backend choice", () => {
  it("reads the admin area of POLYNOVEA_DATA_BACKEND", () => {
    expect(adminBackend(undefined)).toBe("supabase");
    expect(adminBackend("postgres")).toBe("postgres");
    expect(adminBackend("postgres,admin=supabase")).toBe("supabase");
    expect(adminBackend("supabase, admin=postgres")).toBe("postgres");
    expect(() => adminBackend("admin=mysql")).toThrow("unknown backend");
  });
});

describeBothBackends(["admin"], "bootstrap admin writes", (backend) => {
  it("makes an identity the master admin and the only-system-role owner, idempotently", async () => {
    const w = await workspaceWithRoles(backend);
    const store = await storeFor(backend);
    const suffix = randomUUID().slice(0, 8);
    const email = `owner-${suffix}@example.test`;
    const input = { authUserId: randomUUID(), email, username: `owner-${suffix}`, displayName: "Owner", workspaceSlug: w.slug };

    const first = await store.grantOwner(input);
    expect(first.workspaceId).toBe(w.workspaceId);
    const [admin] = await backend.query<{ role: string; is_active: boolean; module_access: string[]; auth_user_id: string; created_by: string }>("select role, is_active, module_access, auth_user_id, created_by from admin_users where id = $1", [first.adminUserId]);
    expect(admin).toEqual({ role: "master", is_active: true, module_access: ["*"], auth_user_id: input.authUserId, created_by: "bootstrap:admin" });

    // An existing member with another system role ends with only the owner role.
    await backend.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [first.memberId, w.editorRoleId]);
    const again = await store.grantOwner({ ...input, authUserId: randomUUID(), displayName: "Owner 2" });
    expect(again).toEqual({ ...first });
    const roles = await backend.query<{ role_id: string }>("select role_id from member_roles where workspace_member_id = $1", [first.memberId]);
    expect(roles).toEqual([{ role_id: w.ownerRoleId }]);
    const [updated] = await backend.query<{ display_name: string }>("select display_name from admin_users where id = $1", [first.adminUserId]);
    expect(updated.display_name).toBe("Owner 2");

    await expect(store.grantOwner({ ...input, workspaceSlug: `missing-${suffix}` })).rejects.toThrow();
    recorder.record(backend.name, "bootstrap", { keys: Object.keys(first).sort() });
  });
});

describe("bootstrap admin backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
