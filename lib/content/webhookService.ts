import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { decryptConfig, encryptConfig } from "@/lib/content/secureConfig";
import * as webhookData from "@/lib/content/webhookData";
import { assertSafeOutboundUrl } from "@/lib/infrastructure/networkSafety";
import { guardedFetch } from "@/lib/infrastructure/guardedNetwork";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const retryAt = (attempt: number) => new Date(Date.now() + Math.min(3_600_000, 1_000 * 2 ** attempt)).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event filters arrive from the request body: a short list of short event names. */
function checkEventFilters(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200)) {
    throw new Error("Event filters must be a list of event names");
  }
  return [...new Set(value as string[])];
}

export async function createWebhookSubscription(params: {
  workspaceId: string;
  actorId: string;
  name: string;
  endpointUrl: string;
  eventFilters: string[];
}) {
  if (typeof params.name !== "string" || !params.name.trim() || typeof params.endpointUrl !== "string") {
    throw new Error("A name and HTTPS endpoint are required");
  }
  const eventFilters = checkEventFilters(params.eventFilters);
  await assertSafeOutboundUrl(params.endpointUrl, "production");
  const secret = randomBytes(32).toString("base64url");
  const data = await webhookData.insertSubscription({
    workspace_id: params.workspaceId,
    name: params.name.trim(),
    endpoint_url: params.endpointUrl,
    event_filters: eventFilters,
    signing_secret_hash: hash(secret),
    signing_secret_encrypted: encryptConfig({ secret }),
    created_by: params.actorId,
  }, (subscription) => ({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "webhook.subscription_created",
    entityType: "webhook_subscription",
    entityId: subscription.id,
  }));
  return { subscription: data, signingSecret: secret };
}

export async function listWebhookSubscriptions(workspaceId: string) {
  return webhookData.listSubscriptions(workspaceId);
}

export async function listWebhookDeliveries(workspaceId: string, subscriptionId?: string) {
  if (subscriptionId && !UUID.test(subscriptionId)) return [];
  return webhookData.listDeliveries(workspaceId, subscriptionId || undefined);
}

export async function setWebhookSubscriptionActive(params: {
  workspaceId: string;
  actorId: string;
  subscriptionId: string;
  active: boolean;
}) {
  if (!UUID.test(params.subscriptionId)) throw new Error("Webhook subscription not found");
  return webhookData.setSubscriptionActive(params.workspaceId, params.subscriptionId, params.active, {
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: params.active ? "webhook.subscription_enabled" : "webhook.subscription_disabled",
    entityType: "webhook_subscription",
    entityId: params.subscriptionId,
  });
}

export async function rotateWebhookSecret(params: { workspaceId: string; actorId: string; subscriptionId: string }) {
  if (!UUID.test(params.subscriptionId)) throw new Error("Webhook subscription not found");
  const secret = randomBytes(32).toString("base64url");
  const data = await webhookData.replaceSigningSecret(params.workspaceId, params.subscriptionId, { hash: hash(secret), encrypted: encryptConfig({ secret }) }, {
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "webhook.secret_rotated",
    entityType: "webhook_subscription",
    entityId: params.subscriptionId,
  });
  return { subscription: data, signingSecret: secret };
}

export async function queueWebhookEvent(params: {
  workspaceId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
}) {
  await webhookData.queueEvent(params, randomUUID());
}

/** Compatibility dispatcher; Phase 10's external worker owns normal execution. */
export async function dispatchWebhookDelivery(deliveryId: string) {
  if (!UUID.test(deliveryId)) return null;
  const delivery = await webhookData.deliveryForDispatch(deliveryId);
  if (!delivery || !delivery.webhook_subscriptions?.active || delivery.status === "succeeded") return null;

  const attempt = delivery.attempt_count + 1;
  const startedAt = Date.now();
  const payload = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    occurredAt: new Date().toISOString(),
    data: delivery.payload_json,
  });
  await webhookData.markDeliveryRunning(delivery.id, attempt);

  try {
    const { secret } = decryptConfig<{ secret: string }>(delivery.webhook_subscriptions.signing_secret_encrypted);
    await assertSafeOutboundUrl(delivery.webhook_subscriptions.endpoint_url, "production");
    const response = await guardedFetch(delivery.webhook_subscriptions.endpoint_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-polynovea-event": delivery.event_type,
        "x-polynovea-delivery": delivery.id,
        "x-polynovea-signature": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const success = response.ok;
    const status = success ? "succeeded" : attempt >= 5 ? "failed" : "queued";
    await webhookData.recordDeliveryOutcome(delivery.id, delivery.subscription_id, {
      delivery: {
        status,
        response_status: response.status,
        completed_at: success ? new Date().toISOString() : null,
        next_attempt_at: success ? null : retryAt(attempt),
        last_error: success ? null : `Endpoint returned ${response.status}`,
      },
      subscription: success ? { consecutive_failures: 0 } : { consecutive_failures: attempt, active: attempt < 5 },
      health: {
      p_workspace_id: delivery.webhook_subscriptions.workspace_id,
      p_destination_kind: "webhook_subscription",
      p_destination_id: delivery.subscription_id,
      p_success: success,
      p_latency_ms: Date.now() - startedAt,
      p_error_code: success ? null : `HTTP_${response.status}`,
      p_error_message: success ? null : `Endpoint returned ${response.status}`,
      p_disabled: !success && attempt >= 5,
      },
    });
    return { ...delivery, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook delivery failed";
    const status = attempt >= 5 ? "failed" : "queued";
    await webhookData.recordDeliveryOutcome(delivery.id, delivery.subscription_id, {
      delivery: { status, next_attempt_at: retryAt(attempt), last_error: message },
      subscription: { consecutive_failures: attempt, active: attempt < 5 },
      health: {
      p_workspace_id: delivery.webhook_subscriptions.workspace_id,
      p_destination_kind: "webhook_subscription",
      p_destination_id: delivery.subscription_id,
      p_success: false,
      p_latency_ms: Date.now() - startedAt,
      p_error_code: "NETWORK_ERROR",
      p_error_message: message,
      p_disabled: attempt >= 5,
      },
    });
    return { ...delivery, status };
  }
}
