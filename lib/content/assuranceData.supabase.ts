// Supabase path of the readiness reads behind preflight and destination assurance (deleted with the
// switch at the end of phase 1). Queries moved unchanged from assuranceService.ts, preflightService.ts,
// and the read paths of webQualityService.ts (getWebQualityPolicy) and localizationService.ts
// (listLocales, getLocalizationStatus). The rules stay in those services and are shared.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
type RouteRow = { id: string; entry_id: string | null; locale: string; path: string; title: string | null; parent_route_id: string | null; is_canonical: boolean; status: string; indexing_policy: string; sitemap_included: boolean; sitemap_priority: number | null; sitemap_changefreq: string | null };
export type AssetForAssurance = { id: string; filename: string; mime_type: string; size_bytes: number; width: number | null; height: number | null; alt_text: string | null; metadata_json: Record<string, unknown>; archived_at: string | null };

export async function routesOfEntry(workspaceId: string, entryId: string): Promise<RouteRow[]> {
  const { data: routes } = await createServiceRoleClient().from("content_routes").select("id,entry_id,locale,path,title,parent_route_id,is_canonical,status,indexing_policy,sitemap_included,sitemap_priority,sitemap_changefreq").eq("workspace_id", workspaceId).eq("entry_id", entryId).neq("status", "archived");
  return (routes ?? []) as RouteRow[];
}

/** An active redirect from `path` for the locale or for all locales. */
export async function activeRedirectFrom(workspaceId: string, path: string, locale: string): Promise<{ id: string; target_path: string; status_code: number } | null> {
  const { data } = await createServiceRoleClient().from("content_redirects").select("id,target_path,status_code").eq("workspace_id", workspaceId).eq("source_path", path).eq("is_active", true).or(`locale.eq.${locale},locale.is.null`).limit(1).maybeSingle();
  return data ?? null;
}

/** Any active redirect from `path`, in any locale (redirect-chain detection). */
export async function anyActiveRedirectFrom(workspaceId: string, path: string): Promise<{ id: string } | null> {
  const { data } = await createServiceRoleClient().from("content_redirects").select("id").eq("workspace_id", workspaceId).eq("source_path", path).eq("is_active", true).limit(1).maybeSingle();
  return data ?? null;
}

export async function liveRouteAtPath(workspaceId: string, locale: string, path: string): Promise<{ id: string; path: string; status: string } | null> {
  const { data } = await createServiceRoleClient().from("content_routes").select("id,path,status").eq("workspace_id", workspaceId).eq("locale", locale).eq("path", path).neq("status", "archived").limit(1).maybeSingle();
  return data ?? null;
}

export async function liveRoutesOfLocale(workspaceId: string, locale: string): Promise<Array<{ id: string; parent_route_id: string | null; path: string; title: string | null; locale: string }>> {
  const { data } = await createServiceRoleClient().from("content_routes").select("id,parent_route_id,path,title,locale").eq("workspace_id", workspaceId).eq("locale", locale).neq("status", "archived");
  return data ?? [];
}

/** Current (draft, else published) version data of every other entry in the workspace. */
export async function otherCurrentVersions(workspaceId: string, exceptEntryId: string): Promise<Array<{ entry_id: string; data_jsonb: Record<string, unknown> }>> {
  const db = createServiceRoleClient();
  const { data: entryRows } = await db.from("content_entries").select("id,current_draft_version_id,published_version_id").eq("workspace_id", workspaceId).neq("id", exceptEntryId);
  const ids = [...new Set((entryRows ?? []).map((e) => e.current_draft_version_id ?? e.published_version_id).filter((id): id is string => Boolean(id)))];
  const { data } = ids.length ? await db.from("content_entry_versions").select("entry_id,data_jsonb").in("id", ids) : { data: [] as Array<{ entry_id: string; data_jsonb: Record<string, unknown> }> };
  return data ?? [];
}

export async function translationOf(workspaceId: string, translatedEntryId: string): Promise<{ id: string; source_entry_id: string; locale: string } | null> {
  const { data } = await createServiceRoleClient().from("content_entry_translations").select("id,source_entry_id,locale").eq("workspace_id", workspaceId).eq("translated_entry_id", translatedEntryId).limit(1).maybeSingle();
  return data ?? null;
}

export async function activeCanonicalRoute(workspaceId: string, entryId: string, locale: string): Promise<{ id: string; path: string } | null> {
  const { data } = await createServiceRoleClient().from("content_routes").select("id,path").eq("workspace_id", workspaceId).eq("entry_id", entryId).eq("locale", locale).eq("is_canonical", true).eq("status", "active").limit(1).maybeSingle();
  return data ?? null;
}

export async function assetsForAssurance(workspaceId: string, assetIds: string[]): Promise<AssetForAssurance[]> {
  if (!assetIds.length) return [];
  const { data } = await createServiceRoleClient().from("assets").select("id,filename,mime_type,size_bytes,width,height,alt_text,metadata_json,archived_at").eq("workspace_id", workspaceId).in("id", assetIds);
  return (data ?? []) as AssetForAssurance[];
}

/** Current draft data of the model's other entries (preflight duplicate check). */
export async function siblingDraftData(workspaceId: string, modelId: string, exceptEntryId: string): Promise<Array<{ data_jsonb: Record<string, unknown> }>> {
  const db = createServiceRoleClient();
  const siblingEntries = await db.from("content_entries").select("id, current_draft_version_id").eq("workspace_id", workspaceId).eq("content_model_id", modelId).neq("id", exceptEntryId);
  const siblingVersionIds = (siblingEntries.data ?? []).map((item) => item.current_draft_version_id).filter((id): id is string => Boolean(id));
  const { data: siblingVersions } = siblingVersionIds.length ? await db.from("content_entry_versions").select("data_jsonb").in("id", siblingVersionIds) : { data: [] as Array<{ data_jsonb: Record<string, unknown> }> };
  return siblingVersions ?? [];
}

export async function entryStatuses(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; status: string }>> {
  if (!entryIds.length) return [];
  const { data } = await createServiceRoleClient().from("content_entries").select("id, status").eq("workspace_id", workspaceId).in("id", entryIds);
  return data ?? [];
}

/** True when a completed workflow approved exactly this version of the entry. */
export async function hasApprovedWorkflow(workspaceId: string, entryId: string, versionId: string): Promise<boolean> {
  void workspaceId; // the caller resolved the entry in the workspace
  const { data: approval } = await createServiceRoleClient().from("workflow_instances").select("id").eq("entry_id", entryId).eq("version_id", versionId).eq("current_state", "approved").not("completed_at", "is", null).limit(1).maybeSingle();
  return Boolean(approval);
}

export async function webQualityPolicyRow(workspaceId: string): Promise<{ policy: any | null; workspaceName: string | null }> {
  const db = createServiceRoleClient();
  const [{ data }, { data: workspace }] = await Promise.all([
    db.from("web_quality_policies").select("*").eq("workspace_id", workspaceId).maybeSingle(),
    db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
  ]);
  return { policy: data ?? null, workspaceName: workspace?.name ?? null };
}

export async function workspaceLocales(workspaceId: string, includeDisabled: boolean): Promise<any[]> {
  let query = createServiceRoleClient().from("workspace_locales").select("*").eq("workspace_id", workspaceId).order("is_default", { ascending: false }).order("locale");
  if (!includeDisabled) query = query.eq("enabled", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** What getLocalizationStatus reads: the source version's locale, its translations, and their entries. */
export async function localizationRows(workspaceId: string, sourceEntryId: string, sourceVersionId: string): Promise<{ sourceLocale: string | null; translations: any[]; translatedEntries: Array<{ id: string; status: string; current_draft_version_id: string | null; published_version_id: string | null }> }> {
  const db = createServiceRoleClient();
  const [{ data: sourceVersion }, translationsRes] = await Promise.all([
    db.from("content_entry_versions").select("locale").eq("id", sourceVersionId).maybeSingle(),
    db.from("content_entry_translations").select("*").eq("workspace_id", workspaceId).eq("source_entry_id", sourceEntryId),
  ]);
  const translations = translationsRes.data ?? [];
  const translatedIds = translations.map((item) => item.translated_entry_id).filter((id): id is string => Boolean(id));
  const { data: translatedEntries } = translatedIds.length
    ? await db.from("content_entries").select("id,status,current_draft_version_id,published_version_id").eq("workspace_id", workspaceId).in("id", translatedIds)
    : { data: [] as Array<{ id: string; status: string; current_draft_version_id: string | null; published_version_id: string | null }> };
  return { sourceLocale: sourceVersion?.locale ?? null, translations, translatedEntries: translatedEntries ?? [] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
