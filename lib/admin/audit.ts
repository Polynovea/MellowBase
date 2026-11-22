import { usesDirectPostgres } from "@/lib/db/backend";
import { getDb } from "@/lib/db/index";
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import type { AdminUser } from "@/lib/admin/types";

interface AuditPayload {
  actor: AdminUser;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown> | null;
}

function row(payload: AuditPayload) {
  return {
    actor_email: payload.actor.email,
    actor_username: payload.actor.username,
    actor_role: payload.actor.role,
    action: payload.action,
    target_type: payload.targetType,
    target_id: payload.targetId ?? null,
    target_label: payload.targetLabel ?? null,
    details: payload.details ?? {},
  };
}

/**
 * The legacy admin activity log (admin users, blog, social and campaign content). Follows the
 * `admin` switch in POLYNOVEA_DATA_BACKEND. Audit logging must never break the primary action, so it
 * never throws on either path, but a failure reaches the server log instead of vanishing.
 */
export async function logAdminActivity(payload: AuditPayload): Promise<void> {
  try {
    if (usesDirectPostgres("admin")) {
      const entry = row(payload);
      await getDb().insertInto("admin_activity_log").values({ ...entry, details: JSON.stringify(entry.details) }).execute();
      return;
    }
    const { error } = await createServiceRoleClient().from("admin_activity_log").insert(row(payload));
    if (error) throw error;
  } catch (error) {
    console.error("admin activity was not recorded", {
      action: payload.action,
      targetType: payload.targetType,
      error: error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error),
    });
  }
}
