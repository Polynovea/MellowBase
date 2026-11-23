// Direct PostgreSQL implementation of the readiness reads (phase 1, wave 3).
//
// Same signatures and return shapes as assuranceData.supabase.ts. Differences that are deliberate:
// - Versions are read only through their entry's workspace (the versions table has no workspace_id),
//   and the workflow approval lookup joins the entry's workspace too.
// - Locale filters are bound parameters. The Supabase path built PostgREST `or(locale.eq.<locale>,…)`
//   strings from the locale.
// - The duplicate-title and duplicate-unique checks read every current version in one join, without
//   PostgREST's 1000-row cap; route lists have explicit limits and tie-breaks.
// - Lookups that took the first matching row now take the oldest one, so the result is deterministic.
import { sql } from "kysely";
import { DEFAULT_LIST_LIMIT, getDb, maybeOne } from "@/lib/db/index";
import type { AssetForAssurance } from "@/lib/content/assuranceData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
type RouteRow = { id: string; entry_id: string | null; locale: string; path: string; title: string | null; parent_route_id: string | null; is_canonical: boolean; status: string; indexing_policy: string; sitemap_included: boolean; sitemap_priority: number | null; sitemap_changefreq: string | null };

export async function routesOfEntry(workspaceId: string, entryId: string): Promise<RouteRow[]> {
  if (!isUuid(entryId)) return [];
  const rows = await getDb().selectFrom("content_routes")
    .select(["id", "entry_id", "locale", "path", "title", "parent_route_id", "is_canonical", "status", "indexing_policy", "sitemap_included", "sitemap_priority", "sitemap_changefreq"])
    .where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId).where("status", "!=", "archived")
    .orderBy("created_at").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute();
  return rows as unknown as RouteRow[];
}

export async function activeRedirectFrom(workspaceId: string, path: string, locale: string): Promise<{ id: string; target_path: string; status_code: number } | null> {
  const rows = await getDb().selectFrom("content_redirects").select(["id", "target_path", "status_code"])
    .where("workspace_id", "=", workspaceId).where("source_path", "=", path).where("is_active", "=", true)
    .where((eb) => eb.or([eb("locale", "=", locale), eb("locale", "is", null)]))
    .orderBy("created_at").orderBy("id").limit(1).execute();
  return rows[0] ?? null;
}

export async function anyActiveRedirectFrom(workspaceId: string, path: string): Promise<{ id: string } | null> {
  const rows = await getDb().selectFrom("content_redirects").select("id")
    .where("workspace_id", "=", workspaceId).where("source_path", "=", path).where("is_active", "=", true).limit(1).execute();
  return rows[0] ?? null;
}

export async function liveRouteAtPath(workspaceId: string, locale: string, path: string): Promise<{ id: string; path: string; status: string } | null> {
  const rows = await getDb().selectFrom("content_routes").select(["id", "path", "status"])
    .where("workspace_id", "=", workspaceId).where("locale", "=", locale).where("path", "=", path).where("status", "!=", "archived")
    .orderBy("created_at").orderBy("id").limit(1).execute();
  return rows[0] ?? null;
}

export async function liveRoutesOfLocale(workspaceId: string, locale: string): Promise<Array<{ id: string; parent_route_id: string | null; path: string; title: string | null; locale: string }>> {
  return getDb().selectFrom("content_routes").select(["id", "parent_route_id", "path", "title", "locale"])
    .where("workspace_id", "=", workspaceId).where("locale", "=", locale).where("status", "!=", "archived")
    .orderBy("path").orderBy("id").limit(10_000).execute();
}

export async function otherCurrentVersions(workspaceId: string, exceptEntryId: string): Promise<Array<{ entry_id: string; data_jsonb: Record<string, unknown> }>> {
  let query = getDb().selectFrom("content_entries as e")
    .innerJoin("content_entry_versions as v", (join) => join.on(sql<boolean>`v.id = coalesce(e.current_draft_version_id, e.published_version_id)`).onRef("v.entry_id", "=", "e.id"))
    .select(["v.entry_id", "v.data_jsonb"])
    .where("e.workspace_id", "=", workspaceId);
  if (isUuid(exceptEntryId)) query = query.where("e.id", "!=", exceptEntryId);
  return (await query.execute()) as Array<{ entry_id: string; data_jsonb: Record<string, unknown> }>;
}

export async function translationOf(workspaceId: string, translatedEntryId: string): Promise<{ id: string; source_entry_id: string; locale: string } | null> {
  if (!isUuid(translatedEntryId)) return null;
  const rows = await getDb().selectFrom("content_entry_translations").select(["id", "source_entry_id", "locale"])
    .where("workspace_id", "=", workspaceId).where("translated_entry_id", "=", translatedEntryId)
    .orderBy("created_at").orderBy("id").limit(1).execute();
  return rows[0] ?? null;
}

export async function activeCanonicalRoute(workspaceId: string, entryId: string, locale: string): Promise<{ id: string; path: string } | null> {
  if (!isUuid(entryId)) return null;
  const rows = await getDb().selectFrom("content_routes").select(["id", "path"])
    .where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId).where("locale", "=", locale)
    .where("is_canonical", "=", true).where("status", "=", "active")
    .orderBy("created_at").orderBy("id").limit(1).execute();
  return rows[0] ?? null;
}

export async function assetsForAssurance(workspaceId: string, assetIds: string[]): Promise<AssetForAssurance[]> {
  const ids = assetIds.filter(isUuid);
  if (!ids.length) return [];
  const rows = await getDb().selectFrom("assets")
    .select(["id", "filename", "mime_type", "size_bytes", "width", "height", "alt_text", "metadata_json", "archived_at"])
    .where("workspace_id", "=", workspaceId).where("id", "in", ids).execute();
  return rows as unknown as AssetForAssurance[];
}

export async function siblingDraftData(workspaceId: string, modelId: string, exceptEntryId: string): Promise<Array<{ data_jsonb: Record<string, unknown> }>> {
  if (!isUuid(modelId)) return [];
  let query = getDb().selectFrom("content_entries as e")
    .innerJoin("content_entry_versions as v", (join) => join.onRef("v.id", "=", "e.current_draft_version_id").onRef("v.entry_id", "=", "e.id"))
    .select("v.data_jsonb")
    .where("e.workspace_id", "=", workspaceId).where("e.content_model_id", "=", modelId);
  if (isUuid(exceptEntryId)) query = query.where("e.id", "!=", exceptEntryId);
  return (await query.execute()) as Array<{ data_jsonb: Record<string, unknown> }>;
}

export async function entryStatuses(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; status: string }>> {
  const ids = entryIds.filter(isUuid);
  if (!ids.length) return [];
  return getDb().selectFrom("content_entries").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "in", ids).execute();
}

export async function hasApprovedWorkflow(workspaceId: string, entryId: string, versionId: string): Promise<boolean> {
  if (!isUuid(entryId) || !isUuid(versionId)) return false;
  const rows = await getDb().selectFrom("workflow_instances as w")
    .innerJoin("content_entries as e", "e.id", "w.entry_id")
    .select("w.id")
    .where("e.workspace_id", "=", workspaceId).where("w.entry_id", "=", entryId).where("w.version_id", "=", versionId)
    .where("w.current_state", "=", "approved").where("w.completed_at", "is not", null)
    .limit(1).execute();
  return rows.length > 0;
}

export async function webQualityPolicyRow(workspaceId: string): Promise<{ policy: any | null; workspaceName: string | null }> {
  const db = getDb();
  const [policy, workspace] = await Promise.all([
    db.selectFrom("web_quality_policies").selectAll().where("workspace_id", "=", workspaceId).execute().then((rows) => maybeOne(rows)),
    db.selectFrom("workspaces").select("name").where("id", "=", workspaceId).execute().then((rows) => maybeOne(rows)),
  ]);
  return { policy: policy ?? null, workspaceName: workspace?.name ?? null };
}

export async function workspaceLocales(workspaceId: string, includeDisabled: boolean): Promise<any[]> {
  let query = getDb().selectFrom("workspace_locales").selectAll().where("workspace_id", "=", workspaceId);
  if (!includeDisabled) query = query.where("enabled", "=", true);
  return query.orderBy("is_default", "desc").orderBy("locale").limit(DEFAULT_LIST_LIMIT).execute();
}

export async function localizationRows(workspaceId: string, sourceEntryId: string, sourceVersionId: string): Promise<{ sourceLocale: string | null; translations: any[]; translatedEntries: Array<{ id: string; status: string; current_draft_version_id: string | null; published_version_id: string | null }> }> {
  if (!isUuid(sourceEntryId) || !isUuid(sourceVersionId)) return { sourceLocale: null, translations: [], translatedEntries: [] };
  const db = getDb();
  const [sourceVersion, translations] = await Promise.all([
    db.selectFrom("content_entry_versions as v").innerJoin("content_entries as e", "e.id", "v.entry_id")
      .select("v.locale").where("e.workspace_id", "=", workspaceId).where("v.id", "=", sourceVersionId).execute().then((rows) => maybeOne(rows)),
    db.selectFrom("content_entry_translations").selectAll().where("workspace_id", "=", workspaceId).where("source_entry_id", "=", sourceEntryId)
      .orderBy("locale").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
  ]);
  const translatedIds = translations.map((item) => item.translated_entry_id).filter((id): id is string => Boolean(id));
  const translatedEntries = translatedIds.length
    ? await db.selectFrom("content_entries").select(["id", "status", "current_draft_version_id", "published_version_id"])
      .where("workspace_id", "=", workspaceId).where("id", "in", translatedIds).execute()
    : [];
  return { sourceLocale: sourceVersion?.locale ?? null, translations, translatedEntries };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
