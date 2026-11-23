import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));

// The Supabase client (above) still verifies Supabase sessions; admin profiles come from the
// PostgreSQL profile store, faked here with the row each test configures through fakeDb().
let profileRow: Record<string, unknown> | null = null;
let profileError: unknown = null;
vi.mock("@/lib/admin/profileResolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/profileResolution")>()),
  postgresAdminProfileStore: () => ({
    findActiveByAuthUserId: async () => { if (profileError) throw profileError; return profileRow; },
    findActiveUnlinkedByEmail: async () => null,
    linkAuthUser: async () => null,
  }),
}));

import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { requireAdminRequest } from "@/lib/admin/serverAccess";

const mockCreateServiceRoleClient = vi.mocked(createServiceRoleClient);

interface FakeDbOptions {
  getUser: { data: { user: { id: string; email: string } | null }; error: unknown };
  adminUserRow?: Record<string, unknown> | null;
  adminUserError?: unknown;
}

function fakeDb({ getUser, adminUserRow = null, adminUserError = null }: FakeDbOptions) {
  profileRow = adminUserRow;
  profileError = adminUserError;
  const query = {
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: adminUserRow, error: adminUserError }),
      }),
    }),
  };
  return {
    auth: { getUser: vi.fn().mockResolvedValue(getUser) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(query),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function reqWithToken(token?: string): Request {
  return new Request("https://example.com/api/test", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const editorRow = {
  id: "row-1",
  username: "editor",
  email: "editor@example.com",
  role: "editor",
  is_active: true,
  surface_access: ["cms"],
  module_access: ["cms.blog"],
  module_write_access: ["cms.blog"],
};

beforeEach(() => {
  mockCreateServiceRoleClient.mockReset();
  profileRow = null;
  // Pinned here, never read from the shell: these cases are about the Supabase (bearer) provider,
  // and the built-in cases set their own.
  delete process.env.AUTH_PROVIDER;
  profileError = null;
});

describe("requireAdminRequest", () => {
  it("rejects requests with no Authorization header", async () => {
    const result = await requireAdminRequest(reqWithToken());
    expect(result.data).toBeUndefined();
    expect(result.error?.status).toBe(401);
  });

  it("uses the built-in provider's cookie session when AUTH_PROVIDER=builtin, with no Supabase key", async () => {
    const identityProvider = await import("@/lib/auth/betterAuth/instance");
    const verifyRequest = vi.fn().mockResolvedValue({
      identity: { user: { id: "u9", email: "editor@example.com", emailConfirmedAt: null, metadata: {} }, sessionId: "s1", authenticatedAt: new Date(), transport: "cookie", authenticators: 0 },
      error: null,
    });
    const spy = vi.spyOn(identityProvider, "getBuiltinServerIdentityProvider").mockReturnValue({ verifyRequest } as never);
    process.env.AUTH_PROVIDER = "builtin";
    try {
      mockCreateServiceRoleClient.mockReturnValue(fakeDb({ getUser: { data: { user: null }, error: null }, adminUserRow: editorRow }));
      const result = await requireAdminRequest(new Request("https://example.com/api/test", { headers: { cookie: "__Host-polynovea.session_token=x" } }));
      expect(verifyRequest).toHaveBeenCalledOnce();
      expect(result.data?.identity.transport).toBe("cookie");
      expect(result.data?.profile.username).toBe("editor");
    } finally {
      delete process.env.AUTH_PROVIDER;
      spy.mockRestore();
    }
  });

  describe("built-in auth: CSRF, MFA and step-up", () => {
    const secret = "t".repeat(40);
    async function run(
      profileRow: Record<string, unknown>,
      identity: Record<string, unknown>,
      request: Request,
      options: Parameters<typeof requireAdminRequest>[1] = {},
    ) {
      const instance = await import("@/lib/auth/betterAuth/instance");
      const verifyRequest = vi.fn().mockResolvedValue({
        identity: { user: { id: "u10", email: "x@example.com", emailConfirmedAt: null, metadata: {} }, sessionId: "s1", authenticatedAt: new Date(), transport: "cookie", authenticators: 2, ...identity },
        error: null,
      });
      const spy = vi.spyOn(instance, "getBuiltinServerIdentityProvider").mockReturnValue({ verifyRequest } as never);
      Object.assign(process.env, { AUTH_PROVIDER: "builtin", POLYNOVEA_AUTH_SECRET: secret, POLYNOVEA_PUBLIC_URL: "https://cms.example.test" });
      try {
        mockCreateServiceRoleClient.mockReturnValue(fakeDb({ getUser: { data: { user: null }, error: null }, adminUserRow: profileRow }));
        return await requireAdminRequest(request, options);
      } finally {
        for (const key of ["AUTH_PROVIDER", "POLYNOVEA_AUTH_SECRET", "POLYNOVEA_PUBLIC_URL"]) delete process.env[key];
        spy.mockRestore();
      }
    }
    const post = async (withToken: boolean) => {
      const { csrfToken } = await import("@/lib/auth/requestSecurity");
      return new Request("https://cms.example.test/api/test", {
        method: "POST",
        headers: { origin: "https://cms.example.test", ...(withToken ? { "x-polynovea-csrf": csrfToken("s1", secret) } : {}) },
      });
    };
    const code = async (result: { error?: Response }) => (result.error ? (await result.error.json()).code : null);

    it("refuses a state-changing cookie request without the session's CSRF token", async () => {
      expect(await code(await run(editorRow, {}, await post(false)))).toBe("CSRF_FAILED");
      expect((await run(editorRow, {}, await post(true))).data?.profile.username).toBe("editor");
    });

    it("sends an owner with fewer than two authenticators, or an admin with none, to set up MFA", async () => {
      const master = { ...editorRow, role: "master" };
      const admin = { ...editorRow, role: "admin" };
      const get = new Request("https://cms.example.test/api/test");
      expect(await code(await run(master, { authenticators: 1 }, get))).toBe("MFA_REQUIRED");
      expect(await code(await run(admin, { authenticators: 0 }, get))).toBe("MFA_REQUIRED");
      expect((await run(admin, { authenticators: 1 }, get)).data).toBeTruthy();
      expect((await run(master, { authenticators: 1 }, get, { allowWithoutMfa: true })).data).toBeTruthy();
      expect((await run(editorRow, { authenticators: 0 }, get)).data).toBeTruthy();
    });

    it("asks for a recent sign-in on step-up actions, after the permission checks", async () => {
      const stale = { authenticatedAt: new Date(Date.now() - 30 * 60_000) };
      expect(await code(await run(editorRow, stale, await post(true), { stepUp: true }))).toBe("STEP_UP_REQUIRED");
      expect((await run(editorRow, {}, await post(true), { stepUp: true })).data).toBeTruthy();
      // Someone without the module is refused for that, not asked to re-authenticate.
      const refused = await run(editorRow, stale, await post(true), { stepUp: true, requiredWriteModule: "cms.metrics" });
      expect(refused.error?.status).toBe(403);
      expect(await code(refused)).toBeUndefined();
    });
  });

  it("returns 500 when the service role key is not configured", async () => {
    mockCreateServiceRoleClient.mockImplementation(() => {
      throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
    });
    const result = await requireAdminRequest(reqWithToken("tok"));
    expect(result.error?.status).toBe(500);
  });

  it("rejects an invalid/expired session token", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      fakeDb({ getUser: { data: { user: null }, error: { message: "invalid" } } }),
    );
    const result = await requireAdminRequest(reqWithToken("bad-token"));
    expect(result.error?.status).toBe(401);
  });

  it("uses the auditable admin_users identity for a provisioned master account", async () => {
    const masterEmail = "owner@example.com";
    const masterRow = { ...editorRow, id: "master-row", username: "owner", email: masterEmail, role: "master" };
    const db = fakeDb({ getUser: { data: { user: { id: "u1", email: masterEmail } }, error: null }, adminUserRow: masterRow });
    mockCreateServiceRoleClient.mockReturnValue(db);
    const result = await requireAdminRequest(reqWithToken("tok"));
    expect(result.error).toBeUndefined();
    expect(result.data?.profile.role).toBe("master");
    expect(result.data?.profile.id).toBe("master-row");
  });

  it("does not self-provision an authenticated identity that lacks an admin_users row", async () => {
    const db = fakeDb({
      getUser: { data: { user: { id: "u1", email: "owner@example.com" } }, error: null },
      adminUserRow: null,
    });
    mockCreateServiceRoleClient.mockReturnValue(db);
    const result = await requireAdminRequest(reqWithToken("tok"));
    expect(result.data).toBeUndefined();
    expect(result.error?.status).toBe(403);
  });

  it("rejects a valid Supabase session with no matching active admin_users row", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      fakeDb({ getUser: { data: { user: { id: "u2", email: "nobody@example.com" } }, error: null }, adminUserRow: null }),
    );
    const result = await requireAdminRequest(reqWithToken("tok"));
    expect(result.error?.status).toBe(403);
  });

  it("grants access for a matched admin_users row with sufficient read module access", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      fakeDb({ getUser: { data: { user: { id: "u3", email: "editor@example.com" } }, error: null }, adminUserRow: editorRow }),
    );
    const result = await requireAdminRequest(reqWithToken("tok"), { requiredModule: "cms.blog" });
    expect(result.error).toBeUndefined();
    expect(result.data?.profile.username).toBe("editor");
  });

  it("rejects when the matched user lacks the required write module", async () => {
    // An empty module_write_access falls back to module_access (see access.test.ts),
    // so this must set a *non-empty* write list that excludes the required module.
    mockCreateServiceRoleClient.mockReturnValue(
      fakeDb({
        getUser: { data: { user: { id: "u4", email: "editor@example.com" } }, error: null },
        adminUserRow: { ...editorRow, module_write_access: ["cms.metrics"] },
      }),
    );
    const result = await requireAdminRequest(reqWithToken("tok"), { requiredWriteModule: "cms.blog" });
    expect(result.error?.status).toBe(403);
  });

  it("rejects a non-master user when requireMaster is set, even with full module wildcards", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      fakeDb({
        getUser: { data: { user: { id: "u5", email: "editor@example.com" } }, error: null },
        adminUserRow: { ...editorRow, module_access: ["*"], module_write_access: ["*"] },
      }),
    );
    const result = await requireAdminRequest(reqWithToken("tok"), { requireMaster: true });
    expect(result.error?.status).toBe(403);
  });

  it("rejects an admin_users row that is not active, even if the Supabase session is valid", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      fakeDb({
        getUser: { data: { user: { id: "u6", email: "editor@example.com" } }, error: null },
        adminUserError: null,
        // The query itself filters on is_active=true, so a deactivated row resolves as "not found".
        adminUserRow: null,
      }),
    );
    const result = await requireAdminRequest(reqWithToken("tok"));
    expect(result.error?.status).toBe(403);
  });
});
