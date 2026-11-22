import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));

import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { getDefaultWorkspace, getWorkspaceById, listWorkspaceCollaborators, listWorkspaceRoles, resolveActor } from "@/lib/platform/actor";
import type { Workspace } from "@/lib/platform/types";

// Unit tests of the Supabase path's actor resolver (the default backend). The fake query builder
// records every filter, so the tests prove which workspace and member each query was scoped to.

const mockCreateServiceRoleClient = vi.mocked(createServiceRoleClient);

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";

const workspace: Workspace = {
  id: WS,
  name: "Polynovea",
  slug: "polynovea",
  status: "active",
  default_locale: "en",
  timezone: "UTC",
  settings_json: {},
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

type Filter = [string, string, unknown];
type Response = { data: unknown; error: { message: string } | null };

interface FakeDbConfig {
  workspaceRow?: Workspace | null;
  /** Returns the member row for the recorded filters, so isolation is decided by the real arguments. */
  member?: (filters: Filter[]) => { id: string; status: string } | null;
  roleRows?: { role_id: string; roles: { key: string; workspace_id: string } }[];
  permissionRows?: { permission_key: string }[];
  errors?: Partial<Record<"workspaces" | "workspace_members" | "member_roles" | "role_permissions" | "roles", { message: string }>>;
}

function fakeDb(config: FakeDbConfig) {
  const calls: Record<string, Filter[]> = {};
  function builder(table: string, respond: (filters: Filter[]) => Response) {
    const filters: Filter[] = [];
    calls[table] = filters;
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      eq: (column: string, value: unknown) => { filters.push(["eq", column, value]); return chain; },
      in: (column: string, value: unknown) => { filters.push(["in", column, value]); return chain; },
      single: () => Promise.resolve(respond(filters)),
      maybeSingle: () => Promise.resolve(respond(filters)),
      then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(respond(filters)).then(resolve, reject),
    };
    return chain;
  }
  const error = (table: keyof NonNullable<FakeDbConfig["errors"]>) => config.errors?.[table] ?? null;
  const from = vi.fn((table: string) => {
    switch (table) {
      case "workspaces":
        return builder(table, () => ({ data: config.workspaceRow === undefined ? workspace : config.workspaceRow, error: error("workspaces") ?? (config.workspaceRow === null ? { message: "not found" } : null) }));
      case "workspace_members":
        return builder(table, (filters) => ({ data: error("workspace_members") ? null : config.member?.(filters) ?? null, error: error("workspace_members") }));
      case "member_roles":
        return builder(table, () => ({ data: error("member_roles") ? null : config.roleRows ?? [], error: error("member_roles") }));
      case "role_permissions":
        return builder(table, () => ({ data: error("role_permissions") ? null : config.permissionRows ?? [], error: error("role_permissions") }));
      case "roles":
        return builder(table, () => ({ data: [], error: error("roles") }));
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
  return { client: { from }, calls };
}

/** A member row only when the query is scoped to exactly this workspace and admin user. */
const memberOf = (workspaceId: string, status = "active") => (filters: Filter[]) =>
  filters.some(([, c, v]) => c === "workspace_id" && v === workspaceId) && filters.some(([, c, v]) => c === "admin_user_id" && v === ADMIN)
    ? { id: MEMBER, status }
    : null;

function use(config: FakeDbConfig) {
  const fake = fakeDb(config);
  mockCreateServiceRoleClient.mockReturnValue(fake.client as never);
  return fake.calls;
}

beforeEach(() => {
  mockCreateServiceRoleClient.mockReset();
});

describe("getDefaultWorkspace", () => {
  it("resolves the seeded polynovea workspace by slug", async () => {
    const calls = use({});
    const result = await getDefaultWorkspace();
    expect(result.slug).toBe("polynovea");
    expect(calls.workspaces).toEqual([["eq", "slug", "polynovea"]]);
  });

  it("throws a clear error when the workspace migration hasn't been applied", async () => {
    use({ workspaceRow: null });
    await expect(getDefaultWorkspace()).rejects.toThrow(/0007_workspace_core/);
  });
});

describe("resolveActor", () => {
  const admin = { id: ADMIN, email: "editor@example.com" };

  it("returns null when the admin user has no workspace_members row", async () => {
    use({ member: () => null });
    expect(await resolveActor(admin, workspace)).toBeNull();
  });

  it("returns null when the member's row is not active", async () => {
    use({ member: memberOf(WS, "suspended") });
    expect(await resolveActor(admin, workspace)).toBeNull();
  });

  it("returns null for malformed IDs without querying", async () => {
    const calls = use({ member: memberOf(WS) });
    expect(await resolveActor({ id: "admin-1", email: "x@example.com" }, workspace)).toBeNull();
    expect(calls.workspace_members).toBeUndefined();
  });

  it("resolves role keys and the union of their permissions, scoped to the member and the workspace", async () => {
    const calls = use({
      member: memberOf(WS),
      roleRows: [{ role_id: "r-editor", roles: { key: "editor", workspace_id: WS } }],
      permissionRows: [{ permission_key: "content.entry.read" }, { permission_key: "content.entry.create" }],
    });
    const actor = await resolveActor(admin, workspace);
    expect(actor?.isMasterBypass).toBe(false);
    expect(actor?.workspaceMemberId).toBe(MEMBER);
    expect(actor?.roleKeys).toEqual(["editor"]);
    expect(actor?.permissions.has("content.entry.read")).toBe(true);
    expect(actor?.permissions.has("schema.manage")).toBe(false);
    expect(calls.workspace_members).toEqual([["eq", "workspace_id", WS], ["eq", "admin_user_id", ADMIN]]);
    expect(calls.member_roles).toEqual([["eq", "workspace_member_id", MEMBER], ["eq", "roles.workspace_id", WS]]);
    expect(calls.role_permissions).toEqual([["in", "role_id", ["r-editor"]]]);
  });

  it("returns an actor with an empty permission set when the member has no roles assigned", async () => {
    const calls = use({ member: memberOf(WS), roleRows: [] });
    const actor = await resolveActor(admin, workspace);
    expect(actor).not.toBeNull();
    expect(actor?.permissions.size).toBe(0);
    expect(calls.role_permissions).toBeUndefined();
  });

  it.each(["workspace_members", "member_roles", "role_permissions"] as const)("throws instead of granting less when %s cannot be read", async (table) => {
    use({
      member: memberOf(WS),
      roleRows: [{ role_id: "r-editor", roles: { key: "editor", workspace_id: WS } }],
      errors: { [table]: { message: "connection reset" } },
    });
    await expect(resolveActor(admin, workspace)).rejects.toThrow(/Could not read/);
  });

  describe("workspace isolation", () => {
    const otherWorkspace: Workspace = { ...workspace, id: OTHER_WS, slug: "other-workspace" };

    it("resolves an actor for a member scoped to that exact workspace", async () => {
      use({ member: memberOf(WS), roleRows: [{ role_id: "r-editor", roles: { key: "editor", workspace_id: WS } }], permissionRows: [{ permission_key: "content.entry.read" }] });
      expect(await resolveActor(admin, workspace)).not.toBeNull();
    });

    it("does not resolve an actor for the same admin user queried against a different workspace", async () => {
      const calls = use({ member: memberOf(WS), roleRows: [{ role_id: "r-editor", roles: { key: "editor", workspace_id: WS } }] });
      expect(await resolveActor(admin, otherWorkspace)).toBeNull();
      expect(calls.workspace_members).toContainEqual(["eq", "workspace_id", OTHER_WS]);
    });
  });
});

describe("lookups", () => {
  it("throws on query errors and answers malformed IDs without querying", async () => {
    use({ errors: { workspaces: { message: "boom" }, roles: { message: "boom" }, workspace_members: { message: "boom" } } });
    await expect(getWorkspaceById(WS)).rejects.toThrow("Could not read workspace");
    await expect(listWorkspaceRoles(WS)).rejects.toThrow("Could not read workspace roles");
    await expect(listWorkspaceCollaborators(WS)).rejects.toThrow("Could not read workspace collaborators");
    expect(await getWorkspaceById("ws-1")).toBeNull();
    expect(await listWorkspaceRoles("ws-1")).toEqual([]);
    expect(await listWorkspaceCollaborators("ws-1")).toEqual([]);
  });
});
