import { logPlatformEventDirect } from "@/lib/platform/audit.postgres";

export interface PlatformAuditPayload {
  workspaceId: string;
  actorAdminUserId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Workspace-scoped audit trail for the new lib/platform/* + lib/schema/*
 * subsystems (schema.*, and eventually content.entry.* / release.* etc.).
 * Deliberately separate from lib/admin/audit.ts's admin_activity_log,
 * which keeps logging the existing CMS/Content Tracking actions unchanged
 * — not merged in Phase 1 to avoid touching working code unnecessarily.
 *
 * Never throws. Code that changes data in a transaction should call recordPlatformEvent
 * (lib/platform/audit.postgres.ts) inside that transaction instead, so the change and its audit
 * trail commit together.
 */
export async function logPlatformEvent(payload: PlatformAuditPayload): Promise<void> {
  return logPlatformEventDirect(payload);
}
