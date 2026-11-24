/**
 * Scheduled publishing through the one permission function: when a scheduled release comes due, the
 * admin it publishes as must STILL be an active member who may publish every model in the release.
 * Rights are re-checked at run time, never trusted from when the release was scheduled. Used by
 * processDueReleases (in the app) and by the delivery worker (through the node loader), one copy.
 */
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { adminAccesses } from "@/lib/developer/items/sideChannels";

export type ScheduleCheck = { ok: true } | { ok: false; reason: "no_scheduler" | "scheduler_not_member" | "scheduler_cannot_publish"; models?: string[] };

export async function scheduledPublishCheck(db: Kysely<DB>, workspaceId: string, actorId: string | null | undefined, releaseId: string): Promise<ScheduleCheck> {
  if (!actorId) return { ok: false, reason: "no_scheduler" };
  const rows = await db.selectFrom("release_items as i")
    .innerJoin("content_entries as e", (join) => join.onRef("e.id", "=", "i.entry_id").on("e.workspace_id", "=", workspaceId))
    .innerJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
    .select("m.api_key").distinct()
    .where("i.release_id", "=", releaseId)
    .execute();
  const apiKeys = rows.map((row) => row.api_key);
  const accesses = await adminAccesses(db, workspaceId, actorId, "schedule", apiKeys);
  if (!accesses) return { ok: false, reason: "scheduler_not_member" };
  const blocked = apiKeys.filter((key) => !accesses.get(key)?.canPublish);
  return blocked.length ? { ok: false, reason: "scheduler_cannot_publish", models: blocked } : { ok: true };
}
