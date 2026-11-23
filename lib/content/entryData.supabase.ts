// Supabase path of the content entry primitives (queries moved unchanged from entryService.ts;
// deleted with the switch at the end of phase 1). Validation, uniqueness and relation rules stay in
// entryService.ts and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import type { ContentEntryRow, ContentEntryVersionRow } from "@/lib/content/entryService";
import type { EntryFunctionName, EntryFunctionResult } from "@/lib/content/entryData";

/** Data of the current draft and published versions of a model's entries (uniqueness checks). */
export async function currentVersionsOfModel(workspaceId: string, modelId: string): Promise<Array<{ entry_id: string; data_jsonb: Record<string, unknown> }> | null> {
  const db = createServiceRoleClient();
  // Do not use a nested PostgREST relation projection here. content_entries
  // has several version foreign keys (draft/published plus the version's
  // entry_id), which makes an unqualified embedded relation ambiguous in
  // Supabase. Resolve current version ids explicitly instead.
  const { data: entries, error } = await db.from("content_entries").select("id, current_draft_version_id, published_version_id").eq("workspace_id", workspaceId).eq("content_model_id", modelId);
  if (error) return null;
  const versionIds = [...new Set((entries ?? []).flatMap((entry: { current_draft_version_id: string | null; published_version_id: string | null }) => [entry.current_draft_version_id, entry.published_version_id].filter((id): id is string => Boolean(id))))];
  if (versionIds.length === 0) return [];
  const { data: versions, error: versionError } = await db.from("content_entry_versions").select("entry_id, data_jsonb").in("id", versionIds);
  if (versionError) return null;
  return versions ?? [];
}

/** The given entries that exist in the workspace, with their models' API keys. Null on failure. */
export async function entriesWithModelKeys(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; content_model_id: string; api_key: string | undefined }> | null> {
  const db = createServiceRoleClient();
  const { data: targets, error } = await db.from("content_entries").select("id, workspace_id, content_model_id").in("id", entryIds).eq("workspace_id", workspaceId);
  if (error) return null;
  // Some entries are missing: the caller refuses the relation, so the models need not be read.
  if ((targets ?? []).length !== entryIds.length) return (targets ?? []).map((target: { id: string; content_model_id: string }) => ({ id: target.id, content_model_id: target.content_model_id, api_key: undefined }));
  const modelIds = [...new Set((targets ?? []).map((target: { content_model_id: string }) => target.content_model_id))];
  const { data: targetModels } = await db.from("content_models").select("id, api_key").in("id", modelIds).eq("workspace_id", workspaceId);
  const apiKeyByModel = new Map((targetModels ?? []).map((target: { id: string; api_key: string }) => [target.id, target.api_key]));
  return (targets ?? []).map((target: { id: string; content_model_id: string }) => ({ id: target.id, content_model_id: target.content_model_id, api_key: apiKeyByModel.get(target.content_model_id) }));
}

/** The given assets of the workspace (with archived_at). Null on failure. */
export async function assetsById(workspaceId: string, assetIds: string[]): Promise<Array<{ id: string; archived_at: string | null }> | null> {
  const { data: assets, error } = await createServiceRoleClient().from("assets").select("id, archived_at").eq("workspace_id", workspaceId).in("id", assetIds);
  if (error) return null;
  return assets ?? [];
}

export async function liveRouteIdsByPath(workspaceId: string, locale: string, paths: string[]): Promise<Map<string, string>> {
  const { data: routes } = await createServiceRoleClient().from("content_routes").select("id,path").eq("workspace_id", workspaceId).eq("locale", locale).neq("status", "archived").in("path", paths);
  return new Map((routes ?? []).map((route) => [route.path, route.id]));
}

export async function listEntries(workspaceId: string, modelId?: string): Promise<(ContentEntryRow & { data?: Record<string, unknown> })[]> {
  const db = createServiceRoleClient();
  let query = db.from("content_entries").select("*").eq("workspace_id", workspaceId).order("updated_at", { ascending: false });
  if (modelId) query = query.eq("content_model_id", modelId);
  const { data } = await query;
  if (!data || data.length === 0) return [];

  const versionIds = [...new Set(data.map((e: ContentEntryRow) => e.current_draft_version_id || e.published_version_id).filter(Boolean))] as string[];
  if (versionIds.length > 0) {
    const { data: versions } = await db
      .from("content_entry_versions")
      .select("id, entry_id, data_jsonb")
      .in("id", versionIds);
    const dataMap = new Map((versions || []).map((v: { id: string; data_jsonb: Record<string, unknown> }) => [v.id, v.data_jsonb]));
    return data.map((e: ContentEntryRow) => ({
      ...e,
      data: (e.current_draft_version_id && dataMap.get(e.current_draft_version_id)) || (e.published_version_id && dataMap.get(e.published_version_id)) || {},
    }));
  }

  return data;
}

export async function getEntry(workspaceId: string, entryId: string): Promise<ContentEntryRow | null> {
  const { data } = await createServiceRoleClient().from("content_entries").select("*").eq("workspace_id", workspaceId).eq("id", entryId).maybeSingle();
  return data ?? null;
}

// Version reads require the entry's workspace (content_entry_versions has no workspace_id of its
// own): an inner embed on the entry_id foreign key, filtered by workspace, then stripped.
const VERSION_IN_WORKSPACE = "*, content_entries!content_entry_versions_entry_id_fkey!inner(workspace_id)";
function withoutEntry<T extends { content_entries?: unknown }>(row: T): Omit<T, "content_entries"> {
  const { content_entries: _entry, ...version } = row;
  return version;
}

export async function listEntryVersions(workspaceId: string, entryId: string): Promise<ContentEntryVersionRow[]> {
  const { data } = await createServiceRoleClient().from("content_entry_versions").select(VERSION_IN_WORKSPACE)
    .eq("entry_id", entryId).eq("content_entries.workspace_id", workspaceId).order("version_number", { ascending: false });
  return (data ?? []).map(withoutEntry) as ContentEntryVersionRow[];
}

export async function findEntryVersion(workspaceId: string, entryId: string, versionId: string): Promise<ContentEntryVersionRow | null> {
  const { data: sourceVersion } = await createServiceRoleClient().from("content_entry_versions").select(VERSION_IN_WORKSPACE)
    .eq("id", versionId).eq("entry_id", entryId).eq("content_entries.workspace_id", workspaceId).maybeSingle();
  return sourceVersion ? withoutEntry(sourceVersion) as ContentEntryVersionRow : null;
}

/** data_jsonb by version ID, for versions of the workspace's entries. */
export async function versionDataByIds(workspaceId: string, versionIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  void workspaceId; // the callers pass version IDs read from the workspace's entries
  const { data: versions } = versionIds.length ? await createServiceRoleClient().from("content_entry_versions").select("id, data_jsonb").in("id", versionIds) : { data: [] as Array<{ id: string; data_jsonb: Record<string, unknown> }> };
  return new Map((versions ?? []).map((v) => [v.id, v.data_jsonb]));
}

/** One of the entry lifecycle SQL functions, with PostgREST's error code and message on failure. */
export async function callEntryFunction<N extends EntryFunctionName>(name: N, args: Record<string, unknown>): Promise<EntryFunctionResult> {
  const { data, error } = await createServiceRoleClient().rpc(name, args);
  if (error || !data) return { ok: false, code: error?.code ?? null, message: error?.message ?? null };
  return { ok: true, data };
}
