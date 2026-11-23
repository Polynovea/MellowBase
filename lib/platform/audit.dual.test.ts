import { expect, it, vi } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { logPlatformEvent } from "@/lib/platform/audit";

// The shared audit logger (phase 1, wave 1): every area writes through it, so on both backends an
// event must land as an audit row plus one webhook delivery and delivery job per matching
// subscription, and a failure must never reach the caller.
describeWithDatabase("shared platform audit logger", (backend) => {
  async function subscribe(workspaceId: string, filters: string[], active = true) {
    const [row] = await backend.query<{ id: string }>(
      `insert into webhook_subscriptions (workspace_id, name, endpoint_url, event_filters, signing_secret_hash, signing_secret_encrypted, active)
       values ($1, 'Audit test', 'https://hooks.example.test/in', $2, 'hash', 'encrypted', $3) returning id`,
      [workspaceId, filters, active],
    );
    return row.id;
  }

  it("records the audit row with its JSON payloads", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await logPlatformEvent({
      workspaceId,
      actorAdminUserId: adminUserId,
      action: "schema.model_updated",
      entityType: "content_model",
      entityId: workspaceId,
      beforeJson: { name: "Old" },
      afterJson: { name: "New", fields: [1, 2] },
      metadata: { reason: "test" },
    });
    const rows = await backend.query(
      "select action, entity_type, entity_id, actor_admin_user_id, before_json, after_json, metadata_json from platform_audit_events where workspace_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([{
      action: "schema.model_updated",
      entity_type: "content_model",
      entity_id: workspaceId,
      actor_admin_user_id: adminUserId,
      before_json: { name: "Old" },
      after_json: { name: "New", fields: [1, 2] },
      metadata_json: { reason: "test" },
    }]);
  });

  it("defaults the optional fields the same way", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await logPlatformEvent({ workspaceId, actorAdminUserId: adminUserId, action: "probe.minimal", entityType: "probe" });
    const rows = await backend.query(
      "select entity_id, before_json, after_json, metadata_json from platform_audit_events where workspace_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([{ entity_id: null, before_json: null, after_json: null, metadata_json: {} }]);
  });

  it("queues one webhook delivery and delivery job per matching active subscription", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const all = await subscribe(workspaceId, []);
    const exact = await subscribe(workspaceId, ["taxonomy.created"]);
    const wildcard = await subscribe(workspaceId, ["*"]);
    await subscribe(workspaceId, ["content.published"]);
    await subscribe(workspaceId, [], false);

    await logPlatformEvent({ workspaceId, actorAdminUserId: adminUserId, action: "taxonomy.created", entityType: "taxonomy", entityId: workspaceId });

    const deliveries = await backend.query<{ subscription_id: string; event_type: string; payload_json: unknown; id: string }>(
      `select d.id, d.subscription_id, d.event_type, d.payload_json from webhook_deliveries d
       join webhook_subscriptions s on s.id = d.subscription_id where s.workspace_id = $1`,
      [workspaceId],
    );
    expect(deliveries.map((d) => d.subscription_id).sort()).toEqual([all, exact, wildcard].sort());
    for (const delivery of deliveries) {
      expect(delivery.event_type).toBe("taxonomy.created");
      expect(delivery.payload_json).toEqual({ entityType: "taxonomy", entityId: workspaceId, metadata: {} });
    }
    const jobs = await backend.query<{ idempotency_key: string; kind: string }>(
      "select idempotency_key, kind from delivery_jobs where workspace_id = $1",
      [workspaceId],
    );
    expect(jobs.map((job) => job.idempotency_key).sort()).toEqual(deliveries.map((d) => `webhook-delivery:${d.id}`).sort());
    expect(new Set(jobs.map((job) => job.kind))).toEqual(new Set(["webhook"]));
  });

  it("never throws when the event cannot be stored, logs it, and sends no webhook", async () => {
    const { workspaceId } = await backend.createWorkspace();
    await subscribe(workspaceId, []);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(logPlatformEvent({
        workspaceId,
        actorAdminUserId: "00000000-0000-0000-0000-000000000000", // no such admin user: foreign key fails
        action: "probe.failure",
        entityType: "probe",
      })).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith("platform audit event was not recorded", expect.objectContaining({ action: "probe.failure", workspaceId }));
    } finally {
      error.mockRestore();
    }
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1", [workspaceId])).toEqual([]);
    const deliveries = await backend.query(
      "select 1 from webhook_deliveries d join webhook_subscriptions s on s.id = d.subscription_id where s.workspace_id = $1",
      [workspaceId],
    );
    expect(deliveries).toEqual([]);
  });
});
