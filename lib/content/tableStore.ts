// Current content from the model tables (phase 3, wave 3).
//
// Each model's current content lives in two places: its JSONB snapshots (content_entry_versions, the
// history, written on every save as before) and its table, content.<table_name> (written by
// polynovea_content_sync_entries in the same transaction as every save; migration 0076). A model reads
// its current content from the table once content_model_storage.read_source is 'table', which only
// polynovea_content_set_read_source() can set, after a run that matched every count and checksum.
// Switching back to 'snapshot' is the rollback.
//
// This module turns table rows back into the `data` object the rest of the CMS knows:
// - every field with a column comes from the table, by the table's recorded shape (column.field is
//   the key, column name is the column; never hard-coded);
// - fields without a column (to-many relations) come from the same version's snapshot;
// - an empty column is left out (the snapshot usually has no key for it either), and keys that are no
//   longer fields of the model are not returned;
// - values come back in one form per type: timestamps as ISO 8601 in UTC with milliseconds
//   ("2026-01-01T00:00:00.000Z"), numbers as JSON numbers, dates as "YYYY-MM-DD".
//
// Workspace isolation: a model table holds one model, so one workspace. A table is only ever resolved
// through content_model_tables with the caller's workspace, and its rows are only ever read joined to
// content_entries of that workspace and model.
import { sql } from "kysely";
import { getDb, type DbExecutor } from "@/lib/db/index";
import { hasNoColumn } from "@/lib/schema/engine/columns";
import { STORAGE_COLUMNS, TABLE_NAME_PATTERN } from "@/lib/schema/engine/names";
import type { ColumnShape, TableShape } from "@/lib/schema/engine/plan";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Variant = "draft" | "published";

/** A model whose current-content reads use its table. */
export interface TableSource {
  modelId: string;
  table: string;
  shape: TableShape;
  /** Field keys stored outside the table (to-many relations): read from the version's snapshot. */
  snapshotKeys: string[];
  /** The model's current field keys: a column waiting for its deletion to be confirmed is not returned. */
  fieldKeys: ReadonlySet<string>;
}

export interface TableRow {
  entryId: string;
  variant: Variant;
  locale: string;
  data: Record<string, unknown>;
}

/** The models (of `modelIds`, in this workspace) that read from their tables. */
export async function tableSources(workspaceId: string, modelIds: Iterable<string>, db: DbExecutor = getDb()): Promise<Map<string, TableSource>> {
  const ids = [...new Set([...modelIds].filter((id) => UUID.test(id)))];
  if (!ids.length) return new Map();
  const rows = await db.selectFrom("content_model_storage as s")
    .innerJoin("content_model_tables as t", (join) => join.onRef("t.content_model_id", "=", "s.content_model_id").onRef("t.workspace_id", "=", "s.workspace_id"))
    // The table is read only while it is at the model's current schema version: while a schema change
    // is waiting for the worker, the model's reads stay on the snapshots.
    .innerJoin("content_models as m", (join) => join.onRef("m.id", "=", "s.content_model_id").onRef("m.workspace_id", "=", "s.workspace_id"))
    .innerJoin("content_model_versions as v", (join) => join.onRef("v.id", "=", "t.applied_version_id").onRef("v.content_model_id", "=", "t.content_model_id")
      .onRef("v.version_number", "=", "m.current_schema_version"))
    // ...and only while the latest run matched on the table's current shape, with no failed sync since.
    // A schema change alters the shape: rows saved before a new column existed lack its values, so
    // reads stay on the snapshots until the model is backfilled and verified again (npm run content:move).
    .innerJoin("content_model_move_runs as r", (join) => join.onRef("r.id", "=", "s.last_run_id").onRef("r.shape_hash", "=", "t.applied_shape_hash"))
    .select(["s.content_model_id", "t.table_name", "t.applied_shape", "v.schema_json"])
    .where("r.matched", "=", true)
    .where((eb) => eb.or([eb("s.out_of_sync_at", "is", null), eb("s.out_of_sync_at", "<", eb.ref("r.started_at"))]))
    .where("s.workspace_id", "=", workspaceId)
    .where("s.read_source", "=", "table")
    .where("s.content_model_id", "in", ids)
    .execute();
  const sources = new Map<string, TableSource>();
  for (const row of rows) {
    if (!TABLE_NAME_PATTERN.test(row.table_name)) continue;
    const shape = row.applied_shape as unknown as TableShape;
    const schema = row.schema_json as unknown as CanonicalSchema | null;
    const fields = schema?.fields ?? [];
    const snapshotKeys = fields.filter((field) => hasNoColumn(field)).map((field) => field.key);
    sources.set(row.content_model_id, { modelId: row.content_model_id, table: row.table_name, shape, snapshotKeys, fieldKeys: new Set(fields.map((field) => field.key)) });
  }
  return sources;
}

/** Whether `modelId` reads from its table; the source if so. */
export async function tableSource(workspaceId: string, modelId: string, db: DbExecutor = getDb()): Promise<TableSource | null> {
  return (await tableSources(workspaceId, [modelId], db)).get(modelId) ?? null;
}

function normalizeValue(column: ColumnShape, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (column.pgType === "timestamptz" && typeof value === "string") {
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? value : time.toISOString();
  }
  return value;
}

/** A table row (as to_jsonb) back to the data object: field keys, not column names. */
export function rowToData(shape: TableShape, row: Record<string, unknown>, snapshotValues?: Record<string, unknown> | null, fieldKeys?: ReadonlySet<string>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const column of Object.values(shape.columns)) {
    if (fieldKeys && !fieldKeys.has(column.field)) continue;
    const value = normalizeValue(column, row[column.name]);
    if (value !== undefined) data[column.field] = value;
  }
  for (const [key, value] of Object.entries(snapshotValues ?? {})) {
    if (!(key in data)) data[key] = value;
  }
  return data;
}

/**
 * The table rows of `entryIds` (entries of `source`'s model in this workspace). `variant` limits them
 * to one variant. Rows of entries in another workspace or model are never returned.
 */
export async function readTableRows(
  workspaceId: string,
  source: TableSource,
  options: { entryIds?: string[]; variant?: Variant } = {},
  db: DbExecutor = getDb(),
): Promise<TableRow[]> {
  if (!TABLE_NAME_PATTERN.test(source.table)) return [];
  const entryIds = options.entryIds?.filter((id) => UUID.test(id));
  if (entryIds && !entryIds.length) return [];
  const table = sql.id("content", source.table);
  const entryCol = sql.ref(`r.${STORAGE_COLUMNS.entryId}`);
  const variantCol = sql.ref(`r.${STORAGE_COLUMNS.variant}`);
  const localeCol = sql.ref(`r.${STORAGE_COLUMNS.locale}`);
  const keys = source.snapshotKeys;
  const snapshotPart = keys.length
    ? sql`(select jsonb_object_agg(k, v.data_jsonb -> k) from unnest(${keys}::text[]) k where jsonb_typeof(v.data_jsonb) = 'object' and v.data_jsonb ? k)`
    : sql`null::jsonb`;
  const versionJoin = keys.length
    ? sql`left join public.content_entry_versions v
            on v.id = case when ${variantCol} = 'draft' then e.current_draft_version_id else e.published_version_id end and v.entry_id = e.id`
    : sql``;
  const { rows } = await sql<{ entry_id: string; variant: Variant; locale: string; row: Record<string, unknown>; snapshot: Record<string, unknown> | null }>`
    select ${entryCol} as entry_id, ${variantCol} as variant, ${localeCol} as locale, to_jsonb(r) as row, ${snapshotPart} as snapshot
      from ${table} r
      join public.content_entries e on e.id = ${entryCol} and e.workspace_id = ${workspaceId} and e.content_model_id = ${source.modelId}
      ${versionJoin}
     where true
       ${entryIds ? sql`and ${entryCol} = any (${entryIds}::uuid[])` : sql``}
       ${options.variant ? sql`and ${variantCol} = ${options.variant}` : sql``}
     order by ${entryCol}, ${variantCol}`.execute(db);
  return rows.map((row) => ({ entryId: row.entry_id, variant: row.variant, locale: row.locale, data: rowToData(source.shape, row.row, row.snapshot, source.fieldKeys) }));
}

/** Data by entry id for one variant (the row of that variant, if the entry has one). */
export async function tableDataByEntry(workspaceId: string, source: TableSource, entryIds: string[], variant: Variant, db: DbExecutor = getDb()): Promise<Map<string, TableRow>> {
  const rows = await readTableRows(workspaceId, source, { entryIds, variant }, db);
  return new Map(rows.map((row) => [row.entryId, row]));
}

/**
 * The "current" data of entries the way the CMS defines it: the draft if there is one, otherwise the
 * published version. `entries` carry their model and pointers. Returns data only for entries of models
 * that read from their tables; the caller keeps the snapshot data for every other entry.
 */
export async function currentTableData(
  workspaceId: string,
  entries: Array<{ id: string; content_model_id: string; current_draft_version_id: string | null; published_version_id: string | null }>,
  db: DbExecutor = getDb(),
): Promise<Map<string, TableRow>> {
  const sources = await tableSources(workspaceId, entries.map((entry) => entry.content_model_id), db);
  const result = new Map<string, TableRow>();
  if (!sources.size) return result;
  for (const source of sources.values()) {
    const ofModel = entries.filter((entry) => entry.content_model_id === source.modelId);
    if (!ofModel.length) continue;
    const rows = await readTableRows(workspaceId, source, { entryIds: ofModel.map((entry) => entry.id) }, db);
    const byKey = new Map(rows.map((row) => [`${row.entryId}:${row.variant}`, row]));
    for (const entry of ofModel) {
      const variant: Variant | null = entry.current_draft_version_id ? "draft" : entry.published_version_id ? "published" : null;
      const row = variant ? byKey.get(`${entry.id}:${variant}`) : undefined;
      if (row) result.set(entry.id, row);
    }
  }
  return result;
}
