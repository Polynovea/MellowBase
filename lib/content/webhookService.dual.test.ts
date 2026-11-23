import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";

// The delivery request itself is not under test: the endpoint answers with whatever status is queued here.
const responses: number[] = [];
vi.mock("@/lib/infrastructure/guardedNetwork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infrastructure/guardedNetwork")>()),
  guardedFetch: vi.fn(async () => new Response(null, { status: responses.shift() ?? 200 })),
}));

const {
  createWebhookSubscription, dispatchWebhookDelivery, listWebhookDeliveries, listWebhookSubscriptions, queueWebhookEvent, rotateWebhookSecret, setWebhookSubscriptionActive,
} = await import("@/lib/content/webhookService");
const ENDPOINT = "https://93.184.215.14/hooks/cms"; // a public address literal, so no DNS lookup

beforeAll(() => {
  vi.stubEnv("CMS_CONFIG_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

describeWithDatabase("webhook subscriptions and deliveries", (backend) => {
  it("creates, lists, disables, enables and rotates subscriptions inside the workspace", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await expect(createWebhookSubscription({ workspaceId, actorId: adminUserId, name: "Bad", endpointUrl: "https://127.0.0.1/hook", eventFilters: [] })).rejects.toThrow("Private network destinations");
    await expect(createWebhookSubscription({ workspaceId, actorId: adminUserId, name: "Bad", endpointUrl: ENDPOINT, eventFilters: "content.entry.published" as unknown as string[] })).rejects.toThrow("Event filters must be a list");
    await expect(createWebhookSubscription({ workspaceId, actorId: adminUserId, name: " ", endpointUrl: ENDPOINT, eventFilters: [] })).rejects.toThrow("A name and HTTPS endpoint are required");

    const created = await createWebhookSubscription({ workspaceId, actorId: adminUserId, name: " Site build ", endpointUrl: ENDPOINT, eventFilters: ["content.entry.published", "content.entry.published"] });
    expect(created.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.subscription).toMatchObject({ name: "Site build", endpoint_url: ENDPOINT, event_filters: ["content.entry.published"], active: true });
    expect(Object.keys(created.subscription)).not.toContain("signing_secret_encrypted");
    const [stored] = await backend.query<{ signing_secret_hash: string; signing_secret_encrypted: string }>("select signing_secret_hash, signing_secret_encrypted from webhook_subscriptions where id = $1", [created.subscription.id]);
    expect(stored.signing_secret_encrypted).not.toContain(created.signingSecret);

    const listed = await listWebhookSubscriptions(workspaceId);
    expect(listed.map((s) => s.id)).toEqual([created.subscription.id]);
    const other = await backend.createWorkspace();
    expect(await listWebhookSubscriptions(other.workspaceId)).toEqual([]);

    const id = created.subscription.id;
    await expect(setWebhookSubscriptionActive({ workspaceId: other.workspaceId, actorId: other.adminUserId, subscriptionId: id, active: false })).rejects.toThrow("Webhook subscription not found");
    await expect(setWebhookSubscriptionActive({ workspaceId, actorId: adminUserId, subscriptionId: "nope", active: false })).rejects.toThrow("Webhook subscription not found");
    await backend.query("update webhook_subscriptions set consecutive_failures = 3 where id = $1", [id]);
    const disabled = await setWebhookSubscriptionActive({ workspaceId, actorId: adminUserId, subscriptionId: id, active: false });
    expect(disabled).toMatchObject({ id, active: false, consecutive_failures: 3 });
    const enabled = await setWebhookSubscriptionActive({ workspaceId, actorId: adminUserId, subscriptionId: id, active: true });
    expect(enabled).toMatchObject({ id, active: true, consecutive_failures: 0 });

    await expect(rotateWebhookSecret({ workspaceId: other.workspaceId, actorId: other.adminUserId, subscriptionId: id })).rejects.toThrow("Webhook subscription not found");
    const rotated = await rotateWebhookSecret({ workspaceId, actorId: adminUserId, subscriptionId: id });
    expect(rotated.signingSecret).not.toBe(created.signingSecret);
    const [after] = await backend.query<{ signing_secret_hash: string }>("select signing_secret_hash from webhook_subscriptions where id = $1", [id]);
    expect(after.signing_secret_hash).not.toBe(stored.signing_secret_hash);

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'webhook_subscription' order by created_at, action", [workspaceId]);
    expect(events.map((e) => e.action).sort()).toEqual(["webhook.secret_rotated", "webhook.subscription_created", "webhook.subscription_disabled", "webhook.subscription_enabled"]);
  });

  it("queues matching events once, lists deliveries per workspace and records delivery outcomes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { subscription } = await createWebhookSubscription({ workspaceId, actorId: adminUserId, name: "Build", endpointUrl: ENDPOINT, eventFilters: ["content.entry.published"] });
    const eventId = randomUUID();
    await queueWebhookEvent({ workspaceId, eventType: "content.entry.published", eventId, payload: { entryId: "e1", tags: ["a", "b"] } });
    await queueWebhookEvent({ workspaceId, eventType: "content.entry.published", eventId, payload: { entryId: "e1" } }); // same event: no second delivery
    await queueWebhookEvent({ workspaceId, eventType: "content.entry.deleted", eventId: randomUUID(), payload: {} }); // filtered out

    const deliveries = await listWebhookDeliveries(workspaceId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ subscription_id: subscription.id, event_type: "content.entry.published", event_id: eventId, status: "queued", attempt_count: 0, payload_json: { entryId: "e1", tags: ["a", "b"] }, webhook_subscriptions: { id: subscription.id, workspace_id: workspaceId, name: "Build", endpoint_url: ENDPOINT, active: true } });
    expect(JSON.stringify(deliveries)).not.toContain("signing_secret");
    expect(await listWebhookDeliveries(workspaceId, subscription.id)).toHaveLength(1);
    expect(await listWebhookDeliveries(workspaceId, "nope")).toEqual([]);
    const other = await backend.createWorkspace();
    expect(await listWebhookDeliveries(other.workspaceId)).toEqual([]);
    expect(await listWebhookDeliveries(other.workspaceId, subscription.id)).toEqual([]);
    const jobs = await backend.query<{ kind: string; idempotency_key: string }>("select kind, idempotency_key from delivery_jobs where workspace_id = $1", [workspaceId]);
    expect(jobs).toEqual([{ kind: "webhook", idempotency_key: `webhook-delivery:${deliveries[0].id}` }]);

    responses.push(500);
    expect(await dispatchWebhookDelivery(deliveries[0].id)).toMatchObject({ status: "queued" });
    let [row] = await listWebhookDeliveries(workspaceId);
    expect(row).toMatchObject({ status: "queued", attempt_count: 1, response_status: 500, last_error: "Endpoint returned 500", completed_at: null });
    expect(row.next_attempt_at).not.toBeNull();
    expect((await listWebhookSubscriptions(workspaceId))[0]).toMatchObject({ consecutive_failures: 1, active: true });

    responses.push(204);
    expect(await dispatchWebhookDelivery(deliveries[0].id)).toMatchObject({ status: "succeeded" });
    [row] = await listWebhookDeliveries(workspaceId);
    expect(row).toMatchObject({ status: "succeeded", attempt_count: 2, response_status: 204, last_error: null, next_attempt_at: null });
    expect((await listWebhookSubscriptions(workspaceId))[0]).toMatchObject({ consecutive_failures: 0, active: true });
    expect(await dispatchWebhookDelivery(deliveries[0].id)).toBeNull(); // already delivered
    expect(await dispatchWebhookDelivery("nope")).toBeNull();
  });
});
