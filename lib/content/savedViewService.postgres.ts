// Direct PostgreSQL implementation of saved entry views (phase 1, wave 3). Same signatures and
// shapes as savedViewService.supabase.ts; create and delete commit with their audit events, and a
// failed create returns a fixed message (409 for a duplicate name) instead of database text.
import { DEFAULT_LIST_LIMIT, getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { normalizeFilters, type SavedEntryView } from "@/lib/content/savedViewService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listSavedEntryViews(workspaceId: string, actorAdminUserId: string): Promise<SavedEntryView[]> {
  if (!UUID.test(actorAdminUserId)) return [];
  const rows = await getDb().selectFrom("content_entry_saved_views").selectAll()
    .where("workspace_id", "=", workspaceId).where("created_by", "=", actorAdminUserId)
    .orderBy("updated_at", "desc").orderBy("id", "desc").limit(DEFAULT_LIST_LIMIT).execute();
  return rows as unknown as SavedEntryView[];
}

export async function createSavedEntryView(params: { workspaceId: string; actorAdminUserId: string; name: string; filters: unknown }): Promise<{ ok: true; data: SavedEntryView } | { ok: false; error: string; status: number }> {
  const name = params.name.trim();
  if (!name || name.length > 120) return { ok: false, error: "View name must be between 1 and 120 characters", status: 400 };
  const filters = normalizeFilters(params.filters);
  if (filters.modelId && !UUID.test(filters.modelId)) return { ok: false, error: "Could not save view", status: 400 };
  try {
    const data = await withTransaction(async (trx) => {
      const view = await trx.insertInto("content_entry_saved_views").values({
        workspace_id: params.workspaceId,
        content_model_id: filters.modelId ?? null,
        name,
        filters_json: JSON.stringify(filters),
        created_by: params.actorAdminUserId,
      }).returningAll().executeTakeFirstOrThrow();
      await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorAdminUserId, action: "content.entry_view.created", entityType: "content_entry_saved_view", entityId: view.id, afterJson: filters, metadata: { name } });
      return view;
    });
    return { ok: true, data: data as unknown as SavedEntryView };
  } catch (error) {
    const duplicate = (error as { code?: string })?.code === "23505";
    return { ok: false, error: duplicate ? "A saved view with this name already exists" : "Could not save view", status: duplicate ? 409 : 500 };
  }
}

export async function deleteSavedEntryView(params: { workspaceId: string; actorAdminUserId: string; viewId: string }): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!UUID.test(params.viewId)) return { ok: false, error: "Saved view not found", status: 404 };
  try {
    const deleted = await withTransaction(async (trx) => {
      const existing = maybeOne(await trx.deleteFrom("content_entry_saved_views")
        .where("id", "=", params.viewId).where("workspace_id", "=", params.workspaceId).where("created_by", "=", params.actorAdminUserId)
        .returning(["id", "name", "filters_json"]).execute());
      if (existing) await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorAdminUserId, action: "content.entry_view.deleted", entityType: "content_entry_saved_view", entityId: params.viewId, beforeJson: existing.filters_json, metadata: { name: existing.name } });
      return existing;
    });
    if (!deleted) return { ok: false, error: "Saved view not found", status: 404 };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not delete saved view", status: 500 };
  }
}
