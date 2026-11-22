// Supabase path of the shared audit logger (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { queueWebhookEvent } from "@/lib/content/webhookService";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

export async function logPlatformEvent(payload: PlatformAuditPayload): Promise<void> {
  try {
    const db = createServiceRoleClient();
    await db.from("platform_audit_events").insert({
      workspace_id: payload.workspaceId,
      actor_admin_user_id: payload.actorAdminUserId,
      action: payload.action,
      entity_type: payload.entityType,
      entity_id: payload.entityId ?? null,
      before_json: payload.beforeJson ?? null,
      after_json: payload.afterJson ?? null,
      metadata_json: payload.metadata ?? {},
    });
    await queueWebhookEvent({ workspaceId: payload.workspaceId, eventType: payload.action, eventId: crypto.randomUUID(), payload: { entityType: payload.entityType, entityId: payload.entityId ?? null, metadata: payload.metadata ?? {} } });
  } catch {
    // Audit logging must never break the primary action — same convention
    // as lib/admin/audit.ts's logAdminActivity.
  }
}
