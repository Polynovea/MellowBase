// PostgreSQL implementation of the content entry primitives (phase 1, wave 3).
//
// Deliberate differences from the Supabase path it replaced in phase 1:
// - Every read of content_entry_versions joins content_entries and requires the entry's workspace
// (the versions table has no workspace_id column: see ContentEntryVersions in
// lib/db/generated/database.ts), so a version of another workspace can never be read, whatever ID a
// caller passes. listEntryVersions and findEntryVersion take the workspace for the same reason.
// - The uniqueness check reads the model's current versions in one join, without PostgREST's
// 1000-row cap (which let a duplicate slip past in a model with more than 1000 entries).
// - Lists have explicit limits and id tie-breaks; malformed IDs are "not found".
// - A lifecycle function's own message passes through with its SQLSTATE; any other error becomes a
// generic message with a logged reference instead of database text.
import { sql } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, getDb, maybeOne, SqlFunctionError } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import type { ContentEntryRow, ContentEntryVersionRow } from "@/lib/content/entryService";
import type { EntryFunctionName, EntryFunctionResult } from "@/lib/content/entryData";
import { currentTableData, readTableRows, tableSource } from "@/lib/content/tableStore";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
const uuids = (values: string[]) => values.filter(isUuid);

/** Versions of the workspace's entries only. */
function versionsOfWorkspace(workspaceId: string) {
  return getDb().selectFrom("content_entry_versions as v")
    .innerJoin("content_entries as e", "e.id", "v.entry_id")
    .where("e.workspace_id", "=", workspaceId);
}

export async function currentVersionsOfModel(workspaceId: string, modelId: string): Promise<Array<{ entry_id: string; data_jsonb: Record<string, unknown> }> | null> {
  if (!isUuid(modelId)) return [];
  // Phase 3: a model switched to its table reads its current draft and published rows from there.
  const source = await tableSource(workspaceId, modelId);
  if (source) return (await readTableRows(workspaceId, source)).map((row) => ({ entry_id: row.entryId, data_jsonb: row.data }));
  const rows = await versionsOfWorkspace(workspaceId)
    .select(["v.entry_id", "v.data_jsonb"])
    .where("e.content_model_id", "=", modelId)
    .where((eb) => eb.or([eb("v.id", "=", eb.ref("e.current_draft_version_id")), eb("v.id", "=", eb.ref("e.published_version_id"))]))
    .execute();
  return rows as Array<{ entry_id: string; data_jsonb: Record<string, unknown> }>;
}

export async function entriesWithModelKeys(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; content_model_id: string; api_key: string | undefined }> | null> {
  const ids = uuids(entryIds);
  if (!ids.length) return [];
  const rows = await getDb().selectFrom("content_entries as e")
    .innerJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
    .select(["e.id", "e.content_model_id", "m.api_key"])
    .where("e.workspace_id", "=", workspaceId).where("e.id", "in", ids)
    .execute();
  return rows.map((row) => ({ id: row.id, content_model_id: row.content_model_id, api_key: row.api_key }));
}

export async function assetsById(workspaceId: string, assetIds: string[]): Promise<Array<{ id: string; archived_at: string | null }> | null> {
  const ids = uuids(assetIds);
  if (!ids.length) return [];
  return getDb().selectFrom("assets").select(["id", "archived_at"]).where("workspace_id", "=", workspaceId).where("id", "in", ids).execute();
}

export async function liveRouteIdsByPath(workspaceId: string, locale: string, paths: string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const routes = await getDb().selectFrom("content_routes").select(["id", "path"])
    .where("workspace_id", "=", workspaceId).where("locale", "=", locale).where("status", "!=", "archived").where("path", "in", paths)
    .orderBy("created_at").orderBy("id").execute();
  return new Map(routes.map((route) => [route.path, route.id]));
}

export async function listEntries(workspaceId: string, modelId?: string): Promise<(ContentEntryRow & { data?: Record<string, unknown> })[]> {
  if (modelId && !isUuid(modelId)) return [];
  let query = getDb().selectFrom("content_entries as e")
    // The current version: the draft if there is one, otherwise the published version.
    .leftJoin("content_entry_versions as v", (join) => join.on(sql<boolean>`v.id = coalesce(e.current_draft_version_id, e.published_version_id)`).onRef("v.entry_id", "=", "e.id"))
    .selectAll("e")
    .select(sql<Record<string, unknown>>`coalesce(v.data_jsonb, '{}'::jsonb)`.as("data"))
    .where("e.workspace_id", "=", workspaceId);
  if (modelId) query = query.where("e.content_model_id", "=", modelId);
  const rows = await query.orderBy("e.updated_at", "desc").orderBy("e.id", "desc").limit(DEFAULT_LIST_LIMIT).execute() as unknown as (ContentEntryRow & { data?: Record<string, unknown> })[];
  // Phase 3: entries of models switched to their tables take their current data from the table.
  const fromTables = await currentTableData(workspaceId, rows);
  return fromTables.size ? rows.map((row) => (fromTables.has(row.id) ? { ...row, data: fromTables.get(row.id)!.data } : row)) : rows;
}

export async function getEntry(workspaceId: string, entryId: string): Promise<ContentEntryRow | null> {
  if (!isUuid(entryId)) return null;
  return maybeOne(await getDb().selectFrom("content_entries").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", entryId).execute()) as ContentEntryRow | null;
}

export async function listEntryVersions(workspaceId: string, entryId: string): Promise<ContentEntryVersionRow[]> {
  if (!isUuid(entryId)) return [];
  const rows = await versionsOfWorkspace(workspaceId).selectAll("v").where("v.entry_id", "=", entryId)
    .orderBy("v.version_number", "desc").limit(DEFAULT_LIST_LIMIT).execute();
  return rows as unknown as ContentEntryVersionRow[];
}

export async function findEntryVersion(workspaceId: string, entryId: string, versionId: string): Promise<ContentEntryVersionRow | null> {
  if (!isUuid(entryId) || !isUuid(versionId)) return null;
  return maybeOne(await versionsOfWorkspace(workspaceId).selectAll("v").where("v.id", "=", versionId).where("v.entry_id", "=", entryId).execute()) as ContentEntryVersionRow | null;
}

export async function versionDataByIds(workspaceId: string, versionIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const ids = uuids(versionIds);
  if (!ids.length) return new Map();
  const rows = await versionsOfWorkspace(workspaceId).select(["v.id", "v.data_jsonb"]).where("v.id", "in", ids).execute();
  return new Map(rows.map((row) => [row.id, row.data_jsonb as Record<string, unknown>]));
}

const JSON_ARGS = new Set(["p_data_jsonb", "p_unique_reservations", "p_relations"]);

export async function callEntryFunction<N extends EntryFunctionName>(name: N, args: Record<string, unknown>): Promise<EntryFunctionResult> {
  // jsonb arguments are serialized here; the driver would send a JS array as a PostgreSQL array.
  const prepared = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON_ARGS.has(key) && value != null ? JSON.stringify(value) : value]));
  try {
    const data = await callFunction(name, prepared as never);
    if (!data) return { ok: false, code: null, message: null };
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SqlFunctionError) return { ok: false, code: error.sqlState, message: error.message };
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
    // A real constraint violation keeps its code (the shared mapping turns 23505 into a conflict),
    // but never its database text.
    return { ok: false, code, message: code === "23505" ? null : clientErrorMessage(error, `Could not complete ${name}`) };
  }
}
