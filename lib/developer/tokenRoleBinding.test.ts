import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { roleKeys: ["admin"] as string[], role: { id: "r-owner", key: "owner" } as { id: string; key: string } | undefined };
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { workspaceId: "ws", adminUserId: "admin-1", roleKeys: state.roleKeys } } })),
}));
vi.mock("@/lib/db/index", () => ({
  getDb: () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["selectFrom", "select", "where"]) chain[method] = () => chain;
    chain.executeTakeFirst = async () => state.role;
    return chain;
  },
}));
const create = vi.fn(async (params: Record<string, unknown>) => ({ token: { id: "t" }, secret: "pnv_x", params }));
vi.mock("@/lib/developer/apiTokenService", () => ({ createDeveloperApiToken: (params: Record<string, unknown>) => create(params), listDeveloperApiTokens: vi.fn() }));

import { POST } from "@/app/api/developer/tokens/route";

const request = (body: unknown) => new Request("https://cms.example.test/api/developer/tokens", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("token role binding (security review 4)", () => {
  beforeEach(() => create.mockClear());

  it("a manager cannot bind a token to a role they do not hold (e.g. owner)", async () => {
    state.roleKeys = ["admin"];
    state.role = { id: "r-owner", key: "owner" };
    const response = await POST(request({ name: "t", scopes: ["content.read"], roleId: "r-owner" }));
    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("a role the manager holds is allowed; the owner may bind any role of the workspace", async () => {
    state.roleKeys = ["editor"];
    state.role = { id: "r-editor", key: "editor" };
    expect((await POST(request({ name: "t", scopes: ["content.read"], roleId: "r-editor" }))).status).toBe(201);
    state.roleKeys = ["owner"];
    state.role = { id: "r-viewer", key: "viewer" };
    expect((await POST(request({ name: "t", scopes: ["content.read"], roleId: "r-viewer" }))).status).toBe(201);
    expect(create.mock.calls.map(([params]) => params.roleId)).toEqual(["r-editor", "r-viewer"]);
  });

  it("a role of another workspace (not found here) is refused", async () => {
    state.roleKeys = ["owner"];
    state.role = undefined;
    expect((await POST(request({ name: "t", scopes: ["content.read"], roleId: "r-elsewhere" }))).status).toBe(403);
  });
});
