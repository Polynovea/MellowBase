// Supabase path of the shared audit logger (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { queueWebhookEvent } from "@/lib/content/webhookService";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

export async function logPlatformEvent(payload: PlatformAuditPayload): Promise<void> {
  try {
    const db = createServiceRoleClient();
    const { error } = await db.from("platform_audit_events").insert({
      workspace_id: payload.workspaceId,
      actor_admin_user_id: payload.actorAdminUserId,
      action: payload.action,
      entity_type: payload.entityType,
      entity_id: payload.entityId ?? null,
      before_json: payload.beforeJson ?? null,
      after_json: payload.afterJson ?? null,
      metadata_json: payload.metadata ?? {},
    });
    // No audit row, no webhook: subscribers must never hear of an event the audit trail lacks.
    if (error) throw error;
    await queueWebhookEvent({ workspaceId: payload.workspaceId, eventType: payload.action, eventId: crypto.randomUUID(), payload: { entityType: payload.entityType, entityId: payload.entityId ?? null, metadata: payload.metadata ?? {} } });
  } catch (error) {
    // Audit logging must never break the primary action, but the failure must reach the server log
    // (same line as the direct path in audit.postgres.ts).
    console.error("platform audit event was not recorded", {
      action: payload.action,
      entityType: payload.entityType,
      workspaceId: payload.workspaceId,
      error: error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error),
    });
  }
}
