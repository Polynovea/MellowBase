import { describe, expect, it } from "vitest";
import type { AdminUser } from "@/lib/admin/types";
import { resolveAdminProfile, type AdminProfileStore } from "./profileResolution";

type Row = { id: string; email: string; auth_user_id: string | null; is_active: boolean };

function memoryStore(rows: Row[]): AdminProfileStore & { rows: Row[] } {
  return {
    rows,
    async findActiveByAuthUserId(id) { return (rows.find((r) => r.auth_user_id === id && r.is_active) as unknown as AdminUser) ?? null; },
    async findActiveUnlinkedByEmail(email) { return (rows.find((r) => r.email === email && r.auth_user_id === null && r.is_active) as unknown as AdminUser) ?? null; },
    async linkAuthUser(profileId, authUserId) {
      const row = rows.find((r) => r.id === profileId && r.auth_user_id === null);
      if (!row) return null;
      row.auth_user_id = authUserId;
      return row as unknown as AdminUser;
    },
  };
}

const confirmed = "2026-01-01T00:00:00Z";

describe("resolveAdminProfile", () => {
  it("resolves by the immutable auth user ID", async () => {
    const store = memoryStore([{ id: "p1", email: "owner@example.com", auth_user_id: "auth-1", is_active: true }]);
    expect((await resolveAdminProfile(store, { id: "auth-1", email: "renamed@example.com", email_confirmed_at: confirmed }))?.id).toBe("p1");
  });

  it("does not let a different identity with the same email take over a bound profile", async () => {
    const store = memoryStore([{ id: "p1", email: "owner@example.com", auth_user_id: "auth-1", is_active: true }]);
    expect(await resolveAdminProfile(store, { id: "attacker", email: "owner@example.com", email_confirmed_at: confirmed })).toBeNull();
  });

  it("links a legacy profile once, from a confirmed email", async () => {
    const store = memoryStore([{ id: "p1", email: "owner@example.com", auth_user_id: null, is_active: true }]);
    expect((await resolveAdminProfile(store, { id: "auth-1", email: "Owner@Example.com", email_confirmed_at: confirmed }))?.id).toBe("p1");
    expect(store.rows[0].auth_user_id).toBe("auth-1");
    expect(await resolveAdminProfile(store, { id: "auth-2", email: "owner@example.com", email_confirmed_at: confirmed })).toBeNull();
  });

  it("never links from an unconfirmed email", async () => {
    const store = memoryStore([{ id: "p1", email: "owner@example.com", auth_user_id: null, is_active: true }]);
    expect(await resolveAdminProfile(store, { id: "auth-1", email: "owner@example.com", email_confirmed_at: undefined })).toBeNull();
    expect(store.rows[0].auth_user_id).toBeNull();
  });

  it("ignores inactive profiles", async () => {
    const store = memoryStore([{ id: "p1", email: "owner@example.com", auth_user_id: "auth-1", is_active: false }]);
    expect(await resolveAdminProfile(store, { id: "auth-1", email: "owner@example.com", email_confirmed_at: confirmed })).toBeNull();
  });
});
