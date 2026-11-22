// Direct PostgreSQL implementation of the developer entry list (phase 1, wave 2). Same shape as
// resourceService.supabase.ts: each entry row plus its current version (draft, else published).
// Versions are reached only through the workspace's entries; the page has an id tie-break.
import { getDb, maybeOne } from "@/lib/db/index";
import type { ContentModelRow } from "@/lib/schema/modelService";

// The model is read here, not through the schema area, so this area's data comes from one backend.
async function modelByApiKey(workspaceId: string, apiKey: string) {
  return maybeOne(await getDb().selectFrom("content_models").selectAll()
    .where("workspace_id", "=", workspaceId).where("api_key", "=", apiKey).execute()) as unknown as ContentModelRow | null;
}

export async function listDeveloperEntries(params: { workspaceId: string; modelApiKey?: string; status?: string; locale?: string; limit?: number; offset?: number }) {
  const limit = Math.min(200, Math.max(1, params.limit ?? 50)), offset = Math.max(0, params.offset ?? 0);
  let model: ContentModelRow | null = null;
  if (params.modelApiKey) {
    model = await modelByApiKey(params.workspaceId, params.modelApiKey);
    if (!model) return { rows: [], model: null, limit, offset };
  }
  const modelId = model?.id;
  const db = getDb();
  let query = db.selectFrom("content_entries").selectAll().where("workspace_id", "=", params.workspaceId);
  if (modelId) query = query.where("content_model_id", "=", modelId);
  if (params.status) query = query.where("status", "=", params.status);
  const entries = await query.orderBy("updated_at", "desc").orderBy("id", "desc").limit(limit).offset(offset).execute();
  const versionIds = [...new Set(entries.flatMap((entry) => [entry.current_draft_version_id, entry.published_version_id].filter((id): id is string => Boolean(id))))];
  const entryIds = entries.map((entry) => entry.id);
  const versions = versionIds.length
    ? await db.selectFrom("content_entry_versions")
      .select(["id", "entry_id", "version_number", "data_jsonb", "locale", "state", "model_schema_version", "created_at", "change_summary"])
      .where("id", "in", versionIds).where("entry_id", "in", entryIds).execute()
    : [];
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const rows = entries
    .map((entry) => {
      const current = entry.current_draft_version_id ? versionById.get(entry.current_draft_version_id) : entry.published_version_id ? versionById.get(entry.published_version_id) : null;
      return { ...entry, currentVersion: current ?? null };
    })
    .filter((entry) => !params.locale || entry.currentVersion?.locale === params.locale);
  return { rows, model, limit, offset };
}
