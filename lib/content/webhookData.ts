// PostgreSQL implementation of the webhook subscription and delivery reads and writes (phase 1,
// wave 3). Deliberate differences from the Supabase path it replaced in phase 1:
// - Subscription writes commit with their audit events.
// - Deliveries are read through an explicit join scoped on the subscription's workspace
// (webhook_deliveries has no workspace_id); the signing secret is never selected for a list.
// - Queuing an event writes each delivery and its job in one transaction (queueWebhookEventDirect,
// shared with the direct audit path), so a delivery can no longer exist without its job.
// - An attempt's outcome (delivery, subscription failure count, destination health) commits as one.
import { getDb, callFunction, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { queueWebhookEventDirect, recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type SubscriptionSummary = { id: string; name: string; endpoint_url: string; event_filters: string[]; active: boolean; created_at: string };
export type DispatchDelivery = {
  id: string; subscription_id: string; event_type: string; event_id: string; payload_json: any; status: string; attempt_count: number;
  [key: string]: unknown;
  webhook_subscriptions: { workspace_id: string; endpoint_url: string; signing_secret_encrypted: string; active: boolean };
};
export type DeliveryOutcome = {
  delivery: Record<string, unknown>;
  subscription: Record<string, unknown>;
  health: { p_workspace_id: string; p_destination_kind: string; p_destination_id: string; p_success: boolean; p_latency_ms: number; p_error_code: string | null; p_error_message: string | null; p_disabled: boolean };
};


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = "Webhook subscription not found";

export async function insertSubscription(row: Record<string, unknown>, auditFor: (subscription: SubscriptionSummary) => PlatformAuditPayload): Promise<SubscriptionSummary> {
  try {
    return await withTransaction(async (trx) => {
      const subscription = await trx.insertInto("webhook_subscriptions").values(row as any)
        .returning(["id", "name", "endpoint_url", "event_filters", "active", "created_at"]).executeTakeFirstOrThrow();
      await recordPlatformEvent(trx, auditFor(subscription));
      return subscription;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not create webhook subscription"));
  }
}

export async function listSubscriptions(workspaceId: string): Promise<any[]> {
  return getDb().selectFrom("webhook_subscriptions")
    .select(["id", "name", "endpoint_url", "event_filters", "active", "consecutive_failures", "created_at", "updated_at"])
    .where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute();
}

export async function listDeliveries(workspaceId: string, subscriptionId?: string): Promise<any[]> {
  if (subscriptionId !== undefined && !UUID.test(subscriptionId)) return [];
  let query = getDb().selectFrom("webhook_deliveries as d").innerJoin("webhook_subscriptions as s", "s.id", "d.subscription_id")
    .selectAll("d")
    .select(["s.id as s_id", "s.workspace_id as s_workspace_id", "s.name as s_name", "s.endpoint_url as s_endpoint_url", "s.active as s_active"])
    .where("s.workspace_id", "=", workspaceId);
  if (subscriptionId) query = query.where("d.subscription_id", "=", subscriptionId);
  const rows = await query.orderBy("d.created_at", "desc").orderBy("d.id").limit(200).execute();
  return rows.map(({ s_id, s_workspace_id, s_name, s_endpoint_url, s_active, ...delivery }) => ({
    ...delivery,
    webhook_subscriptions: { id: s_id, workspace_id: s_workspace_id, name: s_name, endpoint_url: s_endpoint_url, active: s_active },
  }));
}

export async function setSubscriptionActive(workspaceId: string, subscriptionId: string, active: boolean, audit: PlatformAuditPayload): Promise<any> {
  if (!UUID.test(subscriptionId)) throw new Error(NOT_FOUND);
  return withTransaction(async (trx) => {
    const subscription = await trx.updateTable("webhook_subscriptions")
      .set({ active, updated_at: new Date().toISOString(), ...(active ? { consecutive_failures: 0 } : {}) })
      .where("workspace_id", "=", workspaceId).where("id", "=", subscriptionId)
      .returning(["id", "name", "endpoint_url", "event_filters", "active", "consecutive_failures", "updated_at"]).executeTakeFirst();
    if (!subscription) throw new Error(NOT_FOUND);
    await recordPlatformEvent(trx, audit);
    return subscription;
  });
}

export async function replaceSigningSecret(workspaceId: string, subscriptionId: string, secret: { hash: string; encrypted: string }, audit: PlatformAuditPayload): Promise<any> {
  if (!UUID.test(subscriptionId)) throw new Error(NOT_FOUND);
  return withTransaction(async (trx) => {
    const subscription = await trx.updateTable("webhook_subscriptions")
      .set({ signing_secret_hash: secret.hash, signing_secret_encrypted: secret.encrypted, updated_at: new Date().toISOString() })
      .where("workspace_id", "=", workspaceId).where("id", "=", subscriptionId)
      .returning(["id", "name", "endpoint_url", "active", "updated_at"]).executeTakeFirst();
    if (!subscription) throw new Error(NOT_FOUND);
    await recordPlatformEvent(trx, audit);
    return subscription;
  });
}

export async function queueEvent(params: { workspaceId: string; eventType: string; eventId: string; payload: Record<string, unknown> }, correlationId: string): Promise<void> {
  await withTransaction((trx) => queueWebhookEventDirect(trx, params, correlationId));
}

export async function deliveryForDispatch(deliveryId: string): Promise<DispatchDelivery | null> {
  if (!UUID.test(deliveryId)) return null;
  const row = await getDb().selectFrom("webhook_deliveries as d").innerJoin("webhook_subscriptions as s", "s.id", "d.subscription_id")
    .selectAll("d")
    .select(["s.workspace_id as s_workspace_id", "s.endpoint_url as s_endpoint_url", "s.signing_secret_encrypted as s_secret", "s.active as s_active"])
    .where("d.id", "=", deliveryId).executeTakeFirst();
  if (!row) return null;
  const { s_workspace_id, s_endpoint_url, s_secret, s_active, ...delivery } = row;
  return { ...delivery, webhook_subscriptions: { workspace_id: s_workspace_id, endpoint_url: s_endpoint_url, signing_secret_encrypted: s_secret, active: s_active } } as DispatchDelivery;
}

export async function markDeliveryRunning(deliveryId: string, attempt: number): Promise<void> {
  await getDb().updateTable("webhook_deliveries").set({ status: "running", attempt_count: attempt }).where("id", "=", deliveryId).execute();
}

export async function recordDeliveryOutcome(deliveryId: string, subscriptionId: string, outcome: DeliveryOutcome): Promise<void> {
  await withTransaction(async (trx) => {
    await trx.updateTable("webhook_deliveries").set(outcome.delivery as any).where("id", "=", deliveryId).execute();
    await trx.updateTable("webhook_subscriptions").set(outcome.subscription as any).where("id", "=", subscriptionId).execute();
    await callFunction("cms_record_destination_health", outcome.health as never, trx);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
