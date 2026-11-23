// PostgreSQL implementation of the published-content delivery API (phase 1, wave 2).
//
// Deliberate differences from the Supabase path it replaced in phase 1:
// - Routes are loaded only for the entries on the page. The Supabase path loaded every canonical
// route in the workspace (capped at 1000 by PostgREST), so a large site served some entries with
// route: null.
// - A malformed entry ID is "not found"; the model lookup is strict about a single active model.
// Every query is scoped by workspace_id; versions are reached only through the workspace's entries.
import { getDb, maybeOne } from "@/lib/db/index";
import { orderLikeEntries, type PublishedContentRecord } from "@/lib/developer/publishedContentService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveModel(workspaceId: string, apiKey: string) {
  return maybeOne(await getDb().selectFrom("content_models").select(["id", "api_key", "name", "status"])
    .where("workspace_id", "=", workspaceId).where("api_key", "=", apiKey).where("status", "=", "active").execute());
}

/**
 * Versions of the workspace's entries only. content_entry_versions has no workspace_id of its own,
 * so the second check on this public API is the join to the entry's workspace.
 */
function versionsInWorkspace(workspaceId: string) {
  return getDb().selectFrom("content_entry_versions as v")
    .innerJoin("content_entries as e", "e.id", "v.entry_id")
    .select(["v.id", "v.entry_id", "v.version_number", "v.data_jsonb", "v.locale", "v.created_at"])
    .where("e.workspace_id", "=", workspaceId);
}

type VersionRow = { id: string; entry_id: string; version_number: number; data_jsonb: unknown; locale: string; created_at: string };

function toRecord(model: { api_key: string }, entry: { id: string; updated_at: string }, version: VersionRow, route: { path: string; locale: string } | undefined): PublishedContentRecord {
  return {
    id: entry.id,
    model: model.api_key,
    locale: version.locale,
    versionId: version.id,
    version: version.version_number,
    publishedAt: version.created_at,
    updatedAt: entry.updated_at,
    data: version.data_jsonb as Record<string, unknown>,
    route: route ? { path: route.path, locale: route.locale } : null,
  };
}

async function canonicalRoutes(workspaceId: string, entryIds: string[]) {
  if (!entryIds.length) return new Map<string, { path: string; locale: string }>();
  const rows = await getDb().selectFrom("content_routes").select(["entry_id", "path", "locale"])
    .where("workspace_id", "=", workspaceId).where("entry_id", "in", entryIds)
    .where("is_canonical", "=", true).where("status", "=", "active")
    .orderBy("created_at").orderBy("id").execute();
  return new Map(rows.map((route) => [`${route.entry_id}:${route.locale}`, route]));
}

export async function listPublishedContent(params: { workspaceId: string; modelApiKey: string; locale?: string; limit?: number; offset?: number }) {
  const model = await resolveModel(params.workspaceId, params.modelApiKey);
  if (!model) return { model: null, records: [] as PublishedContentRecord[] };
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = Math.max(0, params.offset ?? 0);
  const db = getDb();
  const entries = await db.selectFrom("content_entries").select(["id", "published_version_id", "updated_at"])
    .where("workspace_id", "=", params.workspaceId).where("content_model_id", "=", model.id)
    .where("status", "=", "published").where("published_version_id", "is not", null)
    .orderBy("updated_at", "desc").orderBy("id", "desc").limit(limit).offset(offset).execute();
  const versionIds = entries.map((entry) => entry.published_version_id).filter((id): id is string => Boolean(id));
  if (!versionIds.length) return { model, records: [] as PublishedContentRecord[] };
  let versionQuery = versionsInWorkspace(params.workspaceId)
    .where("v.id", "in", versionIds);
  if (params.locale) versionQuery = versionQuery.where("v.locale", "=", params.locale);
  const [versions, routes] = await Promise.all([versionQuery.execute(), canonicalRoutes(params.workspaceId, entries.map((entry) => entry.id))]);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const records = (versions as VersionRow[])
    .filter((version) => entryById.has(version.entry_id))
    .map((version) => toRecord(model, entryById.get(version.entry_id)!, version, routes.get(`${version.entry_id}:${version.locale}`)));
  return { model, records: orderLikeEntries(records, entries) };
}

export async function getPublishedContent(params: { workspaceId: string; modelApiKey: string; entryId: string; locale?: string }) {
  const model = await resolveModel(params.workspaceId, params.modelApiKey);
  if (!model) return { model: null, record: null as PublishedContentRecord | null };
  if (!UUID.test(params.entryId)) return { model, record: null as PublishedContentRecord | null };
  const db = getDb();
  const entry = maybeOne(await db.selectFrom("content_entries").select(["id", "published_version_id", "updated_at"])
    .where("workspace_id", "=", params.workspaceId).where("content_model_id", "=", model.id)
    .where("status", "=", "published").where("id", "=", params.entryId).where("published_version_id", "is not", null).execute());
  if (!entry?.published_version_id) return { model, record: null as PublishedContentRecord | null };
  let versionQuery = versionsInWorkspace(params.workspaceId)
    .where("v.id", "=", entry.published_version_id).where("v.entry_id", "=", entry.id);
  if (params.locale) versionQuery = versionQuery.where("v.locale", "=", params.locale);
  const version = maybeOne(await versionQuery.execute()) as VersionRow | null;
  if (!version) return { model, record: null as PublishedContentRecord | null };
  const routes = await canonicalRoutes(params.workspaceId, [entry.id]);
  return { model, record: toRecord(model, entry, version, routes.get(`${entry.id}:${version.locale}`)) };
}
