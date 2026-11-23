import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { logAdminActivity } from "@/lib/admin/audit";
import { getCommandCenterSnapshot } from "@/lib/admin/commandCenterService";
import { postgresAdminProfileStore, resolveAdminProfile } from "@/lib/admin/profileResolution";
import type { AdminUser } from "@/lib/admin/types";

const store = (_backend: BackendFixtures) => postgresAdminProfileStore();

describeWithDatabase("admin area (activity log, profile resolution, command center)", (backend) => {
  it("records admin activity, and logs instead of throwing when it cannot", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const actor = { email: `actor-${suffix}@example.test`, username: `actor-${suffix}`, role: "admin" } as AdminUser;
    await logAdminActivity({ actor, action: "member.update", targetType: "admin_user", targetId: "t-1", targetLabel: "Someone", details: { role: "editor" } });
    const rows = await backend.query("select actor_email, actor_role, action, target_type, target_id, target_label, details from admin_activity_log where actor_email = $1", [actor.email]);
    expect(rows).toEqual([{ actor_email: actor.email, actor_role: "admin", action: "member.update", target_type: "admin_user", target_id: "t-1", target_label: "Someone", details: { role: "editor" } }]);

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // actor_email is NOT NULL: the insert fails.
      await expect(logAdminActivity({ actor: { ...actor, email: null as never }, action: "probe", targetType: "probe" })).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith("admin activity was not recorded", expect.objectContaining({ action: "probe" }));
    } finally {
      error.mockRestore();
    }
  });

  it("resolves profiles by auth user ID and links a legacy profile exactly once", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const authId = crypto.randomUUID();
    const [bound] = await backend.query<{ id: string }>(
      "insert into admin_users (username, email, auth_user_id) values ($1, $2, $3) returning id",
      [`bound-${suffix}`, `bound-${suffix}@example.test`, authId],
    );
    const s = store(backend);
    expect((await resolveAdminProfile(s, { id: authId, email: "whatever@example.test", emailConfirmedAt: null }))?.id).toBe(bound.id);

    const [legacy] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $2) returning id", [`legacy-${suffix}`, `legacy-${suffix}@example.test`]);
    const newAuth = crypto.randomUUID();
    // An unconfirmed email never links.
    expect(await resolveAdminProfile(s, { id: newAuth, email: `legacy-${suffix}@example.test`, emailConfirmedAt: null })).toBeNull();
    const linked = await resolveAdminProfile(s, { id: newAuth, email: ` LEGACY-${suffix}@example.test `, emailConfirmedAt: "2026-01-01T00:00:00Z" });
    expect(linked).toMatchObject({ id: legacy.id, auth_user_id: newAuth });
    // A second identity can no longer claim it.
    expect(await resolveAdminProfile(s, { id: crypto.randomUUID(), email: `legacy-${suffix}@example.test`, emailConfirmedAt: "2026-01-01T00:00:00Z" })).toBeNull();
    // Inactive profiles never resolve.
    await backend.query("update admin_users set is_active = false where id = $1", [bound.id]);
    expect(await resolveAdminProfile(s, { id: authId, email: null, emailConfirmedAt: null })).toBeNull();
    expect(await s.linkAuthUser(legacy.id, crypto.randomUUID())).toBeNull();
  });

  it("builds the same Command Center snapshot from the same rows", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.createEntry(workspaceId, 1);
    await backend.query("update content_entries set status = 'in_review' where workspace_id = $1", [workspaceId]);
    await backend.query("insert into workspace_environments (workspace_id, key, name, kind, status, is_default) values ($1, 'prod', 'Production', 'production', 'degraded', true)", [workspaceId]);
    await backend.query(
      // Distinct times, so the expected "recent" order is meaningful; ties fall back to id (tested below).
      "insert into delivery_jobs (workspace_id, kind, idempotency_key, status, queue_name, updated_at) values ($1, 'webhook', 'cc-1', 'dead_letter', 'default', now() - interval '1 minute'), ($1, 'webhook', 'cc-2', 'queued', 'default', now())",
      [workspaceId],
    );

    const snapshot = await getCommandCenterSnapshot(workspaceId, adminUserId);
    expect(snapshot.readiness).toBe("blocked");
    expect(snapshot.content).toMatchObject({ models: 1, entries: 1, byStatus: { inReview: 1, draft: 0 } });
    expect(snapshot.delivery).toMatchObject({ queued: 1, deadLetter: 1, running: 0 });
    expect(snapshot.infrastructure.environments).toEqual({ total: 1, ready: 0, problem: 1 });
    expect(snapshot.attention.map((item) => item.key)).toEqual(["environment", "dead-letter", "reviews"]);
    expect(snapshot.infrastructure.defaultEnvironment).toMatchObject({ key: "prod", is_default: true });
    expect(snapshot.delivery.recent.map((job: { status: string }) => job.status)).toEqual(["queued", "dead_letter"]);

    // Rows with identical timestamps come back in id order, not in scan order.
    await backend.query(
      "insert into delivery_jobs (workspace_id, kind, idempotency_key, status, queue_name, updated_at) select $1, 'webhook', 'tie-' || g, 'queued', 'default', '2030-01-01T00:00:00Z' from generate_series(1, 4) g",
      [workspaceId],
    );
    const tied = (await getCommandCenterSnapshot(workspaceId, adminUserId)).delivery.recent.slice(0, 4).map((job: { id: string }) => job.id);
    expect(tied).toEqual([...tied].sort().reverse());

    const other = await backend.createWorkspace();
    const empty = await getCommandCenterSnapshot(other.workspaceId, other.adminUserId);
    expect(empty.content.entries).toBe(0);
    expect(empty.attention.map((item) => item.key)).toEqual(["environment-missing"]);

    const { generatedAt: _generatedAt, ...comparable } = snapshot;
  });
});
