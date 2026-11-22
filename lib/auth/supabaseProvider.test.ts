import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {}, supabaseUrl: "" }));
vi.mock("@/lib/admin/serviceRole", () => ({ createServiceRoleClient: vi.fn() }));

const { toIdentitySession, toIdentityUser } = await import("@/lib/auth/supabaseProvider");

const gotrueUser = {
  id: "8f9a0c1e-0000-4000-8000-000000000001",
  email: "editor@example.com",
  email_confirmed_at: "2026-11-01T10:00:00Z",
  user_metadata: { display_name: "Editor" },
  app_metadata: { provider: "email" },
  aud: "authenticated",
  created_at: "2026-11-01T09:00:00Z",
};

describe("Supabase identity mapping", () => {
  it("maps a GoTrue user to the neutral User type", () => {
    expect(toIdentityUser(gotrueUser as never)).toEqual({
      id: gotrueUser.id,
      email: "editor@example.com",
      emailConfirmedAt: "2026-11-01T10:00:00Z",
      metadata: { display_name: "Editor" },
    });
  });

  it("treats a missing email and confirmation as null, and never carries app_metadata", () => {
    const user = toIdentityUser({ ...gotrueUser, email: undefined, email_confirmed_at: undefined, user_metadata: undefined } as never);
    expect(user).toEqual({ id: gotrueUser.id, email: null, emailConfirmedAt: null, metadata: {} });
  });

  it("maps a session and drops the refresh token", () => {
    const session = toIdentitySession({ access_token: "jwt", refresh_token: "refresh", expires_at: 1_800_000_000, expires_in: 3600, token_type: "bearer", user: gotrueUser } as never);
    expect(session).toEqual({ accessToken: "jwt", expiresAt: 1_800_000_000, user: toIdentityUser(gotrueUser as never) });
    expect(JSON.stringify(session)).not.toContain("refresh");
    expect(toIdentitySession(null)).toBeNull();
  });
});
