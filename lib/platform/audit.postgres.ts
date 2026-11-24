/**
 * Direct PostgreSQL counterpart of lib/platform/audit.ts (wave 1 of the self-hosted upgrade).
 *
 * recordPlatformEvent writes the audit row, the webhook deliveries and their delivery jobs through
 * the executor it is given. Pass the transaction that made the change, and the change, its audit
 * row and its webhooks commit or roll back together. That is stronger than the Supabase path, which
 * wrote them afterwards and swallowed any failure, so a change could land with no audit trail and
 * no webhook.
 */
import { randomUUID } from "node:crypto";
import { callFunction, withTransaction, type DbExecutor } from "@/lib/db/index";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import { webhookPayloadFor } from "@/lib/developer/items/webhooks";

export async function recordPlatformEvent(executor: DbExecutor, payload: PlatformAuditPayload): Promise<void> {
  const metadata = payload.metadata ?? {};
  await executor
    .insertInto("platform_audit_events")
    .values({
      workspace_id: payload.workspaceId,
      actor_admin_user_id: payload.actorAdminUserId,
      action: payload.action,
      entity_type: payload.entityType,
      entity_id: payload.entityId ?? null,
      before_json: payload.beforeJson === undefined ? null : JSON.stringify(payload.beforeJson),
      after_json: payload.afterJson === undefined ? null : JSON.stringify(payload.afterJson),
      metadata_json: JSON.stringify(metadata),
    })
    .execute();

  await queueWebhookEventDirect(executor, {
    workspaceId: payload.workspaceId,
    eventType: payload.action,
    eventId: randomUUID(),
    payload: { entityType: payload.entityType, entityId: payload.entityId ?? null, metadata },
  });
}

/**
 * Stand-alone form for callers that are not in a transaction (logPlatformEvent on the direct path).
 * The audit row and its webhook deliveries commit together. Like the Supabase path it never throws,
 * so an audit failure cannot undo a change that already committed, but unlike that path the failure
 * reaches the server log instead of vanishing.
 */
export async function logPlatformEventDirect(payload: PlatformAuditPayload): Promise<void> {
  try {
    await withTransaction((trx) => recordPlatformEvent(trx, payload));
  } catch (error) {
    console.error("platform audit event was not recorded", {
      action: payload.action,
      entityType: payload.entityType,
      workspaceId: payload.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Same rules as queueWebhookEvent in lib/content/webhookService.ts: one delivery per matching active subscription. */
export async function queueWebhookEventDirect(
  executor: DbExecutor,
  params: { workspaceId: string; eventType: string; eventId: string; payload: Record<string, unknown> },
  correlationId: string = randomUUID(),
): Promise<void> {
  const subscriptions = await executor
    .selectFrom("webhook_subscriptions")
    .select(["id", "event_filters", "created_by"])
    .where("workspace_id", "=", params.workspaceId)
    .where("active", "=", true)
    .execute();
  const matching = subscriptions.filter(
    (item) => item.event_filters.length === 0 || item.event_filters.includes(params.eventType) || item.event_filters.includes("*"),
  );
  if (!matching.length) return;

  for (const subscription of matching) {
    const delivery = await executor
      .insertInto("webhook_deliveries")
      .values({
        subscription_id: subscription.id,
        event_type: params.eventType,
        event_id: params.eventId,
        // Phase 4: per subscription, through the items API's permission function (its owner's access).
        payload_json: JSON.stringify(await webhookPayloadFor(executor, params.workspaceId, subscription.created_by, params.payload)),
      })
      .onConflict((conflict) => conflict.columns(["subscription_id", "event_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!delivery) continue; // Already queued for this subscription and event.

    await callFunction("cms_enqueue_delivery_job", {
      p_workspace_id: params.workspaceId,
      p_actor_id: null,
      p_kind: "webhook",
      p_idempotency_key: `webhook-delivery:${delivery.id}`,
      p_payload: { webhookDeliveryId: delivery.id },
      p_safe_metadata: { webhookDeliveryId: delivery.id, subscriptionId: subscription.id, eventType: params.eventType, eventId: params.eventId },
      p_run_after: new Date().toISOString(),
      p_priority: 100,
      p_max_attempts: 5,
      p_queue_name: "default",
      p_correlation_id: correlationId,
    }, executor);
  }
}
