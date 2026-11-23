// PostgreSQL implementation of the developer entry list (phase 1, wave 2). Same shape as the
// Supabase path: each entry row plus its current version (draft, else published). Versions are
// reached only through the workspace's entries; the page has an id tie-break.
import { getDb, maybeOne } from "@/lib/db/index";
import type { ContentModelRow } from "@/lib/schema/modelService";
import { currentTableData } from "@/lib/content/tableStore";

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
    // content_entry_versions has no workspace_id; the join to the entry's workspace is the second check.
    ? await db.selectFrom("content_entry_versions as v")
      .innerJoin("content_entries as e", "e.id", "v.entry_id")
      .select(["v.id", "v.entry_id", "v.version_number", "v.data_jsonb", "v.locale", "v.state", "v.model_schema_version", "v.created_at", "v.change_summary"])
      .where("e.workspace_id", "=", params.workspaceId)
      .where("v.id", "in", versionIds).where("v.entry_id", "in", entryIds).execute()
    : [];
  const versionById = new Map(versions.map((version) => [version.id, version]));
  // Phase 3: entries of models switched to their tables take the current version's data from the table.
  const fromTables = await currentTableData(params.workspaceId, entries);
  const rows = entries
    .map((entry) => {
      const current = entry.current_draft_version_id ? versionById.get(entry.current_draft_version_id) : entry.published_version_id ? versionById.get(entry.published_version_id) : null;
      const tableRow = fromTables.get(entry.id);
      return { ...entry, currentVersion: current ? (tableRow ? { ...current, data_jsonb: tableRow.data } : current) : null };
    })
    .filter((entry) => !params.locale || entry.currentVersion?.locale === params.locale);
  return { rows, model, limit, offset };
}
