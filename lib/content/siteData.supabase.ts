// Supabase path of the localization writes and the web-quality (robots, sitemap, site audit) reads
// (queries moved unchanged from localizationService.ts and webQualityService.ts; deleted with the
// switch at the end of phase 1). The rules stay in those services and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export async function callConfigureLocale(args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await createServiceRoleClient().rpc("cms_configure_locale", args);
  if (error || !data) throw new Error(error?.message || "Could not configure locale");
  return data;
}

/** The locale of one of the entry's versions (the caller resolved the entry in the workspace). */
export async function versionLocale(workspaceId: string, entryId: string, versionId: string): Promise<string | null> {
  void workspaceId;
  const { data: translatedVersion } = await createServiceRoleClient().from("content_entry_versions").select("locale").eq("id", versionId).eq("entry_id", entryId).maybeSingle();
  return translatedVersion?.locale ?? null;
}

export async function upsertTranslationLink(row: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("content_entry_translations").upsert(row, { onConflict: "source_entry_id,locale" }).select().single();
  if (error) throw new Error(error.message);
  await logPlatformEvent(audit);
  return data;
}

export async function findTranslationLink(workspaceId: string, sourceEntryId: string, locale: string): Promise<{ id: string; translated_entry_id: string | null } | null> {
  const { data: relation } = await createServiceRoleClient().from("content_entry_translations").select("id, translated_entry_id").eq("workspace_id", workspaceId).eq("source_entry_id", sourceEntryId).eq("locale", locale).maybeSingle();
  return relation ?? null;
}

export async function updateTranslationLink(workspaceId: string, id: string, patch: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  void workspaceId; // the caller read the link in the workspace
  const { data, error } = await createServiceRoleClient().from("content_entry_translations").update(patch).eq("id", id).select().single();
  if (error) throw new Error(error.message);
  await logPlatformEvent(audit);
  return data;
}

/** Marks translations whose source version is not the current draft as stale. */
export async function markStale(workspaceId: string, sourceEntryId: string, currentVersionId: string): Promise<void> {
  const now = new Date().toISOString();
  await createServiceRoleClient().from("content_entry_translations").update({ stale_at: now, updated_at: now }).eq("workspace_id", workspaceId).eq("source_entry_id", sourceEntryId).neq("source_version_id", currentVersionId);
}

export async function callUpsertWebQualityPolicy(args: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().rpc("cms_upsert_web_quality_policy", args);
  if (error || !data) throw new Error(error?.message || "Could not save Web Quality policy");
  return data;
}

/** Active canonical routes in the sitemap, and the status of their entries. */
export async function sitemapRows(workspaceId: string): Promise<{ routes: any[]; entries: Array<{ id: string; status: string; updated_at: string }> }> {
  const db = createServiceRoleClient();
  const { data: routes } = await db.from("content_routes")
    .select("id,entry_id,locale,path,updated_at,indexing_policy,sitemap_included,sitemap_priority,sitemap_changefreq")
    .eq("workspace_id", workspaceId).eq("status", "active").eq("is_canonical", true).eq("sitemap_included", true).neq("indexing_policy", "noindex")
    .order("path");
  const entryIds = [...new Set((routes ?? []).map((route) => route.entry_id).filter((id): id is string => Boolean(id)))];
  const { data: entries } = entryIds.length
    ? await db.from("content_entries").select("id,status,updated_at").eq("workspace_id", workspaceId).in("id", entryIds)
    : { data: [] as Array<{ id: string; status: string; updated_at: string }> };
  return { routes: routes ?? [], entries: entries ?? [] };
}

/** Everything the site discoverability audit reads. */
export async function siteAuditRows(workspaceId: string): Promise<{ routes: any[]; redirects: any[]; entries: any[]; versions: Array<{ id: string; entry_id: string; data_jsonb: Record<string, unknown>; locale: string }> }> {
  const db = createServiceRoleClient();
  const [routesRes, redirectsRes, entriesRes] = await Promise.all([
    db.from("content_routes").select("id,entry_id,locale,path,title,parent_route_id,is_canonical,status,indexing_policy,sitemap_included").eq("workspace_id", workspaceId).neq("status", "archived"),
    db.from("content_redirects").select("id,locale,source_path,target_path,is_active").eq("workspace_id", workspaceId).eq("is_active", true),
    db.from("content_entries").select("id,status,current_draft_version_id,published_version_id,content_model_id").eq("workspace_id", workspaceId),
  ]);
  const entries = entriesRes.data ?? [];
  const currentVersionIds = [...new Set(entries.map((e) => e.current_draft_version_id ?? e.published_version_id).filter((id): id is string => Boolean(id)))];
  const { data: versions } = currentVersionIds.length ? await db.from("content_entry_versions").select("id,entry_id,data_jsonb,locale").in("id", currentVersionIds) : { data: [] as Array<{ id: string; entry_id: string; data_jsonb: Record<string, unknown>; locale: string }> };
  return { routes: routesRes.data ?? [], redirects: redirectsRes.data ?? [], entries, versions: versions ?? [] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
