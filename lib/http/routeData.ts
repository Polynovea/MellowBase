// PostgreSQL implementation of the queries API routes made directly (phase 1, wave 5). Deliberate
// differences from the Supabase path it replaced in phase 1:
// - PostgREST embeds are explicit joins, and every joined table is scoped by the workspace.
// - Id lists are bound as one array parameter (`= any(...)`) instead of a URL-length `in (...)` list,
// so a large workspace no longer silently loses rows.
// - A new platform takes the next display position in the insert itself, so two concurrent creates
// do not compute the same position from a stale read.
// - Reads have id tie-breaks and bounds; malformed ids find nothing instead of failing on the uuid cast.
import { sql } from "kysely";
import { DEFAULT_LIST_LIMIT, getDb } from "@/lib/db/index";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the routes read them */
export type PlatformFilter = "social" | "ads" | null;
export type PlatformInput = { name?: string; for_social?: boolean; for_ads?: boolean; is_active?: boolean; sort_order?: number };
export type MemberProfile = { id: string; username: string; display_name: string | null; email: string };


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the routes read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (values: string[]) => [...new Set(values.filter((value) => UUID.test(value)))];

export async function listPlatforms(filter: PlatformFilter): Promise<any[]> {
  let query = getDb().selectFrom("platforms").selectAll();
  if (filter === "social") query = query.where("is_active", "=", true).where("for_social", "=", true);
  if (filter === "ads") query = query.where("is_active", "=", true).where("for_ads", "=", true);
  return query.orderBy("sort_order").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute();
}

export async function createPlatform(input: { name: string; for_social: boolean; for_ads: boolean }): Promise<any> {
  return getDb().insertInto("platforms")
    .values({ ...input, is_active: true, sort_order: sql<number>`(select coalesce(max(sort_order), -1) + 1 from platforms)` })
    .returningAll().executeTakeFirstOrThrow();
}

export async function updatePlatform(id: string, patch: PlatformInput): Promise<any | null> {
  if (!UUID.test(id)) return null;
  return (await getDb().updateTable("platforms").set({ ...patch, updated_at: new Date().toISOString() }).where("id", "=", id).returningAll().executeTakeFirst()) ?? null;
}

export async function deletePlatform(id: string): Promise<void> {
  if (!UUID.test(id)) return;
  await getDb().deleteFrom("platforms").where("id", "=", id).execute();
}

export async function entryIdsInModels(workspaceId: string, modelIds: string[]): Promise<string[]> {
  const models = uuids(modelIds);
  if (!models.length) return [];
  // Used to filter what the caller may see, so the whole set is read.
  const rows = await getDb().selectFrom("content_entries").select("id").where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`content_model_id = any(${models}::uuid[])`).orderBy("id").execute();
  return rows.map((row) => row.id);
}

export async function searchDocuments(workspaceId: string, entryIds: string[]): Promise<Array<{ entry_id: string; search_text: string; status: string; locale: string }>> {
  const entries = uuids(entryIds);
  if (!entries.length) return [];
  return getDb().selectFrom("content_search_documents").select(["entry_id", "search_text", "status", "locale"]).where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`entry_id = any(${entries}::uuid[])`).orderBy("entry_id").orderBy("locale").execute() as Promise<Array<{ entry_id: string; search_text: string; status: string; locale: string }>>;
}

export async function activeMemberProfiles(workspaceId: string): Promise<MemberProfile[]> {
  return getDb().selectFrom("workspace_members as wm")
    .innerJoin("admin_users as u", "u.id", "wm.admin_user_id")
    .select(["u.id", "u.username", "u.display_name", "u.email"])
    .where("wm.workspace_id", "=", workspaceId).where("wm.status", "=", "active").where("u.is_active", "=", true)
    .orderBy("u.id").limit(DEFAULT_LIST_LIMIT).execute() as Promise<MemberProfile[]>;
}

export async function storageKeyRegistered(workspaceId: string, storageKey: string): Promise<boolean> {
  return Boolean(await getDb().selectFrom("assets").select("id").where("workspace_id", "=", workspaceId).where("storage_key", "=", storageKey).limit(1).executeTakeFirst());
}

export async function extensionInstallations(workspaceId: string): Promise<any[]> {
  const rows = await getDb().selectFrom("extension_installations as i")
    .leftJoin("extension_manifests as m", (join) => join.onRef("m.id", "=", "i.manifest_id").onRef("m.workspace_id", "=", "i.workspace_id"))
    .selectAll("i")
    .select(["m.id as m_id", "m.extension_key as m_extension_key", "m.name as m_name", "m.version as m_version", "m.publisher as m_publisher", "m.manifest_sha256 as m_manifest_sha256"])
    .where("i.workspace_id", "=", workspaceId).orderBy("i.created_at", "desc").orderBy("i.id").limit(DEFAULT_LIST_LIMIT).execute();
  return rows.map(({ m_id, m_extension_key, m_name, m_version, m_publisher, m_manifest_sha256, ...installation }) => ({
    ...installation,
    extension_manifests: m_id ? { extension_key: m_extension_key, name: m_name, version: m_version, publisher: m_publisher, manifest_sha256: m_manifest_sha256 } : null,
  }));
}

export async function importRuns(workspaceId: string): Promise<any[]> {
  return getDb().selectFrom("developer_import_runs")
    .select(["id", "content_model_id", "format", "mode", "status", "source_name", "locale", "total_rows", "succeeded_rows", "failed_rows", "errors_json", "result_json", "created_at", "completed_at"])
    .where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").limit(100).execute();
}

export async function schemaRuns(workspaceId: string): Promise<any[]> {
  return getDb().selectFrom("developer_schema_runs")
    .select(["id", "operation", "status", "source_environment", "target_environment", "bundle_hash", "summary_json", "approval_note", "created_at", "completed_at"])
    .where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").limit(100).execute();
}

export async function versionModelKeys(workspaceId: string, versionIds: string[]): Promise<Array<{ id: string; apiKey: string | null }>> {
  const versions = uuids(versionIds);
  if (!versions.length) return [];
  const rows = await getDb().selectFrom("content_entry_versions as v")
    .innerJoin("content_entries as e", "e.id", "v.entry_id")
    .innerJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
    .select(["v.id", "m.api_key"])
    .where("e.workspace_id", "=", workspaceId).where(sql<boolean>`v.id = any(${versions}::uuid[])`).orderBy("v.id").execute();
  return rows.map((row) => ({ id: row.id, apiKey: row.api_key ?? null }));
}

export async function entryModelKeys(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; apiKey: string | null }>> {
  const entries = uuids(entryIds);
  if (!entries.length) return [];
  const rows = await getDb().selectFrom("content_entries as e")
    .innerJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
    .select(["e.id", "m.api_key"])
    .where("e.workspace_id", "=", workspaceId).where(sql<boolean>`e.id = any(${entries}::uuid[])`).orderBy("e.id").execute();
  return rows.map((row) => ({ id: row.id, apiKey: row.api_key ?? null }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
