// Direct PostgreSQL implementation of the localization writes and the web-quality reads
// (phase 1, wave 3). Same signatures and shapes as siteData.supabase.ts. Differences that are
// deliberate:
// - Version reads go through the entry's workspace (content_entry_versions has no workspace_id).
// - Linking, reviewing and marking translations stale are scoped by workspace_id, and the link and
//   review writes commit with their audit events.
// - The sitemap and the site audit read every row (PostgREST capped each read at 1000, so a large
//   site's sitemap silently lost routes and the audit missed findings), in a fixed order.
// - The SQL functions' own messages pass through; database text never does.
import { sql } from "kysely";
import { callFunction, getDb, maybeOne, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

async function call(name: "cms_configure_locale" | "cms_upsert_web_quality_policy", args: Record<string, unknown>, fallback: string): Promise<any> {
  try {
    const data = await callFunction(name, args as never);
    if (!data) throw new Error(fallback);
    return data;
  } catch (error) {
    if (error instanceof SqlFunctionError) throw error;
    throw new Error(clientErrorMessage(error, fallback));
  }
}

export async function callConfigureLocale(args: Record<string, unknown>): Promise<unknown> {
  return call("cms_configure_locale", args, "Could not configure locale");
}

export async function versionLocale(workspaceId: string, entryId: string, versionId: string): Promise<string | null> {
  if (!isUuid(entryId) || !isUuid(versionId)) return null;
  const row = maybeOne(await getDb().selectFrom("content_entry_versions as v").innerJoin("content_entries as e", "e.id", "v.entry_id")
    .select("v.locale").where("e.workspace_id", "=", workspaceId).where("v.id", "=", versionId).where("v.entry_id", "=", entryId).execute());
  return row?.locale ?? null;
}

export async function upsertTranslationLink(row: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  return withTransaction(async (trx) => {
    const link = await trx.insertInto("content_entry_translations").values(row as any)
      // Same as the Supabase upsert on (source_entry_id, locale): every column it sent.
      .onConflict((conflict) => conflict.columns(["source_entry_id", "locale"]).doUpdateSet((eb) => ({
        workspace_id: eb.ref("excluded.workspace_id"), translated_entry_id: eb.ref("excluded.translated_entry_id"), source_version_id: eb.ref("excluded.source_version_id"),
        reviewed_at: eb.ref("excluded.reviewed_at"), stale_at: eb.ref("excluded.stale_at"), updated_at: eb.ref("excluded.updated_at"),
      })))
      .returningAll().executeTakeFirstOrThrow();
    await recordPlatformEvent(trx, audit);
    return link;
  });
}

export async function findTranslationLink(workspaceId: string, sourceEntryId: string, locale: string): Promise<{ id: string; translated_entry_id: string | null } | null> {
  if (!isUuid(sourceEntryId)) return null;
  return maybeOne(await getDb().selectFrom("content_entry_translations").select(["id", "translated_entry_id"])
    .where("workspace_id", "=", workspaceId).where("source_entry_id", "=", sourceEntryId).where("locale", "=", locale).execute());
}

export async function updateTranslationLink(workspaceId: string, id: string, patch: Record<string, unknown>, audit: PlatformAuditPayload): Promise<any> {
  return withTransaction(async (trx) => {
    const link = await trx.updateTable("content_entry_translations").set(patch as any).where("workspace_id", "=", workspaceId).where("id", "=", id)
      .returningAll().executeTakeFirstOrThrow();
    await recordPlatformEvent(trx, audit);
    return link;
  });
}

export async function markStale(workspaceId: string, sourceEntryId: string, currentVersionId: string): Promise<void> {
  const now = new Date().toISOString();
  // `<>` skips rows whose source_version_id is null, exactly like PostgREST's neq.
  await getDb().updateTable("content_entry_translations").set({ stale_at: now, updated_at: now })
    .where("workspace_id", "=", workspaceId).where("source_entry_id", "=", sourceEntryId).where("source_version_id", "<>", currentVersionId).execute();
}

export async function callUpsertWebQualityPolicy(args: Record<string, unknown>): Promise<any> {
  const json = ["p_ai_crawler_policy", "p_media_budget", "p_settings"];
  return call("cms_upsert_web_quality_policy", Object.fromEntries(Object.entries(args).map(([key, value]) => [key, json.includes(key) && value != null ? JSON.stringify(value) : value])), "Could not save Web Quality policy");
}

export async function sitemapRows(workspaceId: string): Promise<{ routes: any[]; entries: Array<{ id: string; status: string; updated_at: string }> }> {
  const db = getDb();
  const routes = await db.selectFrom("content_routes")
    .select(["id", "entry_id", "locale", "path", "updated_at", "indexing_policy", "sitemap_included", "sitemap_priority", "sitemap_changefreq"])
    .where("workspace_id", "=", workspaceId).where("status", "=", "active").where("is_canonical", "=", true).where("sitemap_included", "=", true).where("indexing_policy", "!=", "noindex")
    .orderBy("path").orderBy("id").execute();
  const entryIds = [...new Set(routes.map((route) => route.entry_id).filter((id): id is string => Boolean(id)))];
  const entries = entryIds.length
    ? await db.selectFrom("content_entries").select(["id", "status", "updated_at"]).where("workspace_id", "=", workspaceId).where("id", "in", entryIds).execute()
    : [];
  return { routes, entries };
}

export async function siteAuditRows(workspaceId: string): Promise<{ routes: any[]; redirects: any[]; entries: any[]; versions: Array<{ id: string; entry_id: string; data_jsonb: Record<string, unknown>; locale: string }> }> {
  const db = getDb();
  const [routes, redirects, entries, versions] = await Promise.all([
    db.selectFrom("content_routes").select(["id", "entry_id", "locale", "path", "title", "parent_route_id", "is_canonical", "status", "indexing_policy", "sitemap_included"])
      .where("workspace_id", "=", workspaceId).where("status", "!=", "archived").orderBy("path").orderBy("id").execute(),
    db.selectFrom("content_redirects").select(["id", "locale", "source_path", "target_path", "is_active"])
      .where("workspace_id", "=", workspaceId).where("is_active", "=", true).orderBy("source_path").orderBy("id").execute(),
    db.selectFrom("content_entries").select(["id", "status", "current_draft_version_id", "published_version_id", "content_model_id"])
      .where("workspace_id", "=", workspaceId).orderBy("id").execute(),
    db.selectFrom("content_entries as e")
      .innerJoin("content_entry_versions as v", (join) => join.on(sql<boolean>`v.id = coalesce(e.current_draft_version_id, e.published_version_id)`).onRef("v.entry_id", "=", "e.id"))
      .select(["v.id", "v.entry_id", "v.data_jsonb", "v.locale"])
      .where("e.workspace_id", "=", workspaceId).orderBy("v.id").execute(),
  ]);
  return { routes, redirects, entries, versions: versions as Array<{ id: string; entry_id: string; data_jsonb: Record<string, unknown>; locale: string }> };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
