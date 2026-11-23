// Supabase path of the webhook subscription and delivery reads and writes (queries moved from
// webhookService.ts; deleted with the switch at the end of phase 1). One change: the subscription
// updates read with maybeSingle, so another workspace's id is "not found" instead of PostgREST's
// single-row error text. Secrets, signing, URL safety, the delivery request and the retry rules
// stay in webhookService.ts and are shared.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { enqueueDeliveryJob } from "@/lib/operations/deliveryJobService";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

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

export async function insertSubscription(row: Record<string, unknown>, auditFor: (subscription: SubscriptionSummary) => PlatformAuditPayload): Promise<SubscriptionSummary> {
  const { data, error } = await createServiceRoleClient().from("webhook_subscriptions").insert(row).select("id, name, endpoint_url, event_filters, active, created_at").single();
  if (error || !data) throw new Error(error?.message || "Could not create webhook subscription");
  await logPlatformEvent(auditFor(data as SubscriptionSummary));
  return data as SubscriptionSummary;
}

export async function listSubscriptions(workspaceId: string): Promise<any[]> {
  const { data } = await createServiceRoleClient()
    .from("webhook_subscriptions")
    .select("id, name, endpoint_url, event_filters, active, consecutive_failures, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  return data ?? [];
}

/** The workspace's latest 200 deliveries, each with its subscription. */
export async function listDeliveries(workspaceId: string, subscriptionId?: string): Promise<any[]> {
  let query = createServiceRoleClient()
    .from("webhook_deliveries")
    .select("*, webhook_subscriptions!inner(id, workspace_id, name, endpoint_url, active)")
    .eq("webhook_subscriptions.workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (subscriptionId) query = query.eq("subscription_id", subscriptionId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function setSubscriptionActive(workspaceId: string, subscriptionId: string, active: boolean, audit: PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient()
    .from("webhook_subscriptions")
    .update({ active, updated_at: new Date().toISOString(), consecutive_failures: active ? 0 : undefined })
    .eq("workspace_id", workspaceId)
    .eq("id", subscriptionId)
    .select("id, name, endpoint_url, event_filters, active, consecutive_failures, updated_at")
    .maybeSingle(); // another workspace's id is "not found", not PostgREST's single-row error
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Webhook subscription not found");
  await logPlatformEvent(audit);
  return data;
}

export async function replaceSigningSecret(workspaceId: string, subscriptionId: string, secret: { hash: string; encrypted: string }, audit: PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient()
    .from("webhook_subscriptions")
    .update({ signing_secret_hash: secret.hash, signing_secret_encrypted: secret.encrypted, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", subscriptionId)
    .select("id, name, endpoint_url, active, updated_at")
    .maybeSingle(); // another workspace's id is "not found", not PostgREST's single-row error
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Webhook subscription not found");
  await logPlatformEvent(audit);
  return data;
}

/** One delivery per matching active subscription, each with its delivery job. */
export async function queueEvent(params: { workspaceId: string; eventType: string; eventId: string; payload: Record<string, unknown> }, correlationId: string): Promise<void> {
  const db = createServiceRoleClient();
  const { data: subscriptions } = await db.from("webhook_subscriptions").select("id, event_filters").eq("workspace_id", params.workspaceId).eq("active", true);
  await Promise.all(
    (subscriptions ?? [])
      .filter((item) => item.event_filters.length === 0 || item.event_filters.includes(params.eventType) || item.event_filters.includes("*"))
      .map(async (item) => {
        const { data: delivery, error } = await db
          .from("webhook_deliveries")
          .insert({ subscription_id: item.id, event_type: params.eventType, event_id: params.eventId, payload_json: params.payload })
          .select("id")
          .single();
        if (error?.code === "23505") return;
        if (error || !delivery) throw new Error(error?.message || "Could not queue webhook delivery");
        await enqueueDeliveryJob({
          workspaceId: params.workspaceId,
          kind: "webhook",
          idempotencyKey: `webhook-delivery:${delivery.id}`,
          correlationId,
          payload: { webhookDeliveryId: delivery.id },
          safeMetadata: { webhookDeliveryId: delivery.id, subscriptionId: item.id, eventType: params.eventType, eventId: params.eventId },
        });
      })
  );
}

export async function deliveryForDispatch(deliveryId: string): Promise<DispatchDelivery | null> {
  const { data: delivery } = await createServiceRoleClient()
    .from("webhook_deliveries")
    .select("*, webhook_subscriptions!inner(workspace_id, endpoint_url, signing_secret_encrypted, active)")
    .eq("id", deliveryId)
    .maybeSingle();
  return (delivery as DispatchDelivery | null) ?? null;
}

export async function markDeliveryRunning(deliveryId: string, attempt: number): Promise<void> {
  await createServiceRoleClient().from("webhook_deliveries").update({ status: "running", attempt_count: attempt }).eq("id", deliveryId);
}

/** Records how an attempt ended: the delivery, the subscription's failure count and destination health. */
export async function recordDeliveryOutcome(deliveryId: string, subscriptionId: string, outcome: DeliveryOutcome): Promise<void> {
  const db = createServiceRoleClient();
  await db.from("webhook_deliveries").update(outcome.delivery).eq("id", deliveryId);
  await db.from("webhook_subscriptions").update(outcome.subscription).eq("id", subscriptionId);
  await db.rpc("cms_record_destination_health", outcome.health);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
