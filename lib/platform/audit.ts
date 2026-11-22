import { usesDirectPostgres, type DataArea } from "@/lib/db/backend";
import { logPlatformEventDirect } from "@/lib/platform/audit.postgres";
import { logPlatformEvent as logPlatformEventViaSupabase } from "@/lib/platform/audit.supabase";

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
 * Shared by every area, so it moves first (phase 1, wave 1): the `platform` switch in
 * POLYNOVEA_DATA_BACKEND picks Supabase or direct PostgreSQL. Never throws, on either path. Areas
 * already on the direct path should call recordPlatformEvent (lib/platform/audit.postgres.ts) inside
 * their own transaction instead, so the change and its audit trail commit together.
 */
export async function logPlatformEvent(payload: PlatformAuditPayload): Promise<void> {
  return logPlatformEventFor("platform", payload);
}

/**
 * Same as logPlatformEvent, but follows the given area's backend instead of `platform`. Shared code
 * of an area that has moved (for example the schema area's validate → apply rules) uses it, so the
 * area's audit events land in the same database as its data while the switch exists.
 */
export async function logPlatformEventFor(area: DataArea, payload: PlatformAuditPayload): Promise<void> {
  let direct: boolean;
  try {
    direct = usesDirectPostgres(area);
  } catch {
    return; // Malformed POLYNOVEA_DATA_BACKEND: already logged, and the server refuses to start with it.
  }
  return direct ? logPlatformEventDirect(payload) : logPlatformEventViaSupabase(payload);
}
