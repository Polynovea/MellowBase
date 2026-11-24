/**
 * SQL for the items API. Everything here takes ALREADY-CHECKED input (filter.ts, through the caller's
 * access) and resolved metadata. Identifiers come only from metadata: the model table name (checked
 * against TABLE_NAME_PATTERN) and column names from the table's recorded shape, quoted with
 * sql.id / sql.ref. Every value is a bound parameter, cast to a type from a fixed table of fragments.
 * No raw-string SQL helper is used anywhere in this folder (a unit test checks).
 *
 * Two row sources:
 * - table: content.<table> r, one row per entry, variant and locale (Phase 3). Filter, sort, search.
 * - snapshot: the entry's version snapshot (one row per entry). Used while a model's table is not
 *   ready; it supports plain lists, ids, and sorting on system fields only.
 */
import { sql, type RawBuilder } from "kysely";
import type { DbExecutor } from "@/lib/db/index";
import { rowToData, type TableSource } from "@/lib/content/tableStore";
import { STORAGE_COLUMNS, TABLE_NAME_PATTERN } from "@/lib/schema/engine/names";
import type { ColumnShape, PgColumnType } from "@/lib/schema/engine/plan";
import { ItemsApiError } from "@/lib/developer/items/errors";
import type { ParsedFilter, ResolvedField } from "@/lib/developer/items/filter";
import type { CursorPayload, CursorValue } from "@/lib/developer/items/cursor";
import { SEARCHABLE_TYPES, type FilterScalar, type SortKey, type Variant } from "@/lib/developer/items/types";

const CAST: Record<PgColumnType, RawBuilder<unknown>> = {
  text: sql`text`,
  jsonb: sql`jsonb`,
  numeric: sql`numeric`,
  bigint: sql`bigint`,
  boolean: sql`boolean`,
  date: sql`date`,
  timestamptz: sql`timestamptz`,
  uuid: sql`uuid`,
};
const CAST_ARRAY: Record<PgColumnType, RawBuilder<unknown>> = {
  text: sql`text[]`,
  jsonb: sql`jsonb[]`,
  numeric: sql`numeric[]`,
  bigint: sql`bigint[]`,
  boolean: sql`boolean[]`,
  date: sql`date[]`,
  timestamptz: sql`timestamptz[]`,
  uuid: sql`uuid[]`,
};

/** A model as one query reads it. */
export interface QueryModel {
  id: string;
  apiKey: string;
  /** The verified table, or null (snapshot path). */
  source: TableSource | null;
}

export interface SortSpec extends SortKey {
  resolved: ResolvedField;
}

export interface ItemsQuery {
  workspaceId: string;
  model: QueryModel;
  variant: Variant;
  locale?: string;
  /** Only these entries (get by id, expansion, entry-scoped preview tokens). */
  entryIds?: readonly string[];
  filter?: ParsedFilter | null;
  /** Targets of relation hops in the filter, by api key. */
  relationModels?: ReadonlyMap<string, QueryModel>;
  sort: readonly SortSpec[];
  search?: { term: string; fields: readonly ResolvedField[] } | null;
  after?: CursorPayload | null;
  limit: number;
}

export interface ItemRow {
  entryId: string;
  locale: string;
  variant: Variant;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /** Unsanitised: the caller passes it through sanitise(..., "out"). */
  data: Record<string, unknown>;
  /** The row's sort values, for the next cursor. */
  sortValues: CursorValue[];
}

/** Default order: most recently updated first. */
export const DEFAULT_SORT: readonly SortKey[] = [{ field: "updatedAt", direction: "desc" }];

const SYSTEM_SORTABLE = new Set(["id", "createdAt", "updatedAt", "publishedAt", "locale"]);

export function needsTable(query: Pick<ItemsQuery, "filter" | "search" | "sort">): boolean {
  return Boolean(query.filter) || Boolean(query.search) || query.sort.some((key) => !key.resolved.system || key.field === "locale");
}

function columnOf(source: TableSource, key: string): ColumnShape | null {
  return Object.values(source.shape.columns).find((column) => column.field === key) ?? null;
}

function tableRef(source: TableSource): RawBuilder<unknown> {
  if (!TABLE_NAME_PATTERN.test(source.table)) throw new ItemsApiError("ITEMS_UNAVAILABLE", "This model cannot be read right now");
  return sql.id("content", source.table);
}

const ref = (alias: string, column: string) => sql.ref(`${alias}.${column}`);
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

interface Expr {
  sql: RawBuilder<unknown>;
  pgType: PgColumnType;
  nullable: boolean;
}

/** System field expressions; `rowAlias` is the table row (table path) or the version (snapshot path). */
function systemExpr(key: string, path: "table" | "snapshot"): Expr {
  switch (key) {
    case "id": return { sql: ref("e", "id"), pgType: "uuid", nullable: false };
    case "createdAt": return { sql: ref("e", "created_at"), pgType: "timestamptz", nullable: false };
    case "updatedAt": return { sql: ref("e", "updated_at"), pgType: "timestamptz", nullable: false };
    case "publishedAt": return { sql: ref("pv", "created_at"), pgType: "timestamptz", nullable: true };
    case "locale": return { sql: path === "table" ? ref("r", STORAGE_COLUMNS.locale) : ref("vv", "locale"), pgType: "text", nullable: false };
    default: throw new ItemsApiError("ITEMS_UNAVAILABLE", "Unsupported system field");
  }
}

function fieldExpr(field: ResolvedField, source: TableSource | null, alias: string, path: "table" | "snapshot"): Expr {
  if (field.system) return systemExpr(field.key, path);
  if (!source) throw new ItemsApiError("MODEL_TABLE_NOT_READY", "This model's table is being updated; filtering, sorting and search are back shortly");
  const column = columnOf(source, field.key);
  if (!column) throw new ItemsApiError("MODEL_TABLE_NOT_READY", "This model's table is being updated; filtering, sorting and search are back shortly");
  return { sql: ref(alias, column.name), pgType: column.pgType, nullable: true };
}

const castValue = (value: FilterScalar, pgType: PgColumnType) => sql`cast(${value} as ${CAST[pgType]})`;

function condition(expr: Expr, op: string, value: FilterScalar | FilterScalar[] | boolean): RawBuilder<unknown> {
  const x = expr.sql;
  switch (op) {
    case "eq": return sql`${x} = ${castValue(value as FilterScalar, expr.pgType)}`;
    // neq keeps rows where the field is empty: "not equal to v".
    case "neq": return sql`${x} is distinct from ${castValue(value as FilterScalar, expr.pgType)}`;
    case "in": return sql`${x} = any(cast(${(value as FilterScalar[]).map(String)} as ${CAST_ARRAY[expr.pgType]}))`;
    case "lt": return sql`${x} < ${castValue(value as FilterScalar, expr.pgType)}`;
    case "gt": return sql`${x} > ${castValue(value as FilterScalar, expr.pgType)}`;
    case "contains":
      return expr.pgType === "jsonb"
        ? sql`${x} @> cast(${JSON.stringify([value])} as jsonb)`
        : sql`cast(${x} as text) ilike ${likePattern(String(value))} escape '\\'`;
    case "null": return value ? sql`${x} is null` : sql`${x} is not null`;
    default: throw new ItemsApiError("INVALID_FILTER", "Unknown operator");
  }
}

/** Which row of a table counts for the variant: draft = the draft row, or the published one when there is no draft. */
function variantRow(table: RawBuilder<unknown>, alias: string, variant: Variant): RawBuilder<unknown> {
  const v = ref(alias, STORAGE_COLUMNS.variant);
  if (variant === "published") return sql`${v} = 'published'`;
  return sql`(${v} = 'draft' or (${v} = 'published' and not exists (
    select 1 from ${table} d where d.${sql.id(STORAGE_COLUMNS.entryId)} = ${ref(alias, STORAGE_COLUMNS.entryId)}
       and d.${sql.id(STORAGE_COLUMNS.locale)} = ${ref(alias, STORAGE_COLUMNS.locale)} and d.${sql.id(STORAGE_COLUMNS.variant)} = 'draft')))`;
}

/**
 * Published: every entry with a published version that is not archived. Saving a new draft sets an
 * entry's status to 'draft' but keeps its published version live, so status alone is not the test
 * (the live site must not lose an entry the moment an editor starts changing it).
 */
function entryVisible(alias: string, variant: Variant): RawBuilder<unknown> {
  const notArchived = sql`${ref(alias, "status")} <> 'archived' and ${ref(alias, "archived_at")} is null`;
  return variant === "published"
    ? sql`${ref(alias, "published_version_id")} is not null and ${notArchived}`
    : notArchived;
}

function compileFilter(node: ParsedFilter, q: ItemsQuery, path: "table" | "snapshot", hops: { n: number }): RawBuilder<unknown> {
  switch (node.kind) {
    case "and": return sql`(${sql.join(node.items.map((item) => compileFilter(item, q, path, hops)), sql` and `)})`;
    case "or": return sql`(${sql.join(node.items.map((item) => compileFilter(item, q, path, hops)), sql` or `)})`;
    case "not": return sql`not (${compileFilter(node.item, q, path, hops)})`;
    case "cond": {
      if (node.path.length === 1) return condition(fieldExpr(node.path[0], q.model.source, "r", path), node.op, node.value);
      // One hop through a to-one relation: EXISTS on the target's table, same workspace, same variant rule.
      const [relation, target] = node.path;
      if (target.system && target.key !== "id") throw new ItemsApiError("INVALID_FILTER", "Through a relation, filter on the related item's fields or its id");
      const targetModel = q.relationModels?.get(relation.relation!.target);
      if (!targetModel?.source) throw new ItemsApiError("MODEL_TABLE_NOT_READY", "A related model's table is being updated; try again shortly");
      const relExpr = fieldExpr(relation, q.model.source, "r", path);
      hops.n += 1;
      const t = `h${hops.n}`;
      const te = `he${hops.n}`;
      const table = tableRef(targetModel.source);
      const targetExpr: Expr = target.system ? { sql: ref(te, "id"), pgType: "uuid", nullable: false } : fieldExpr(target, targetModel.source, t, "table");
      return sql`exists (
        select 1 from ${table} ${sql.id(t)}
          join public.content_entries ${sql.id(te)} on ${ref(te, "id")} = ${ref(t, STORAGE_COLUMNS.entryId)}
           and ${ref(te, "workspace_id")} = ${q.workspaceId} and ${ref(te, "content_model_id")} = ${targetModel.id}
         where ${ref(t, STORAGE_COLUMNS.entryId)} = ${relExpr.sql}
           and ${variantRow(table, t, q.variant)} and ${entryVisible(te, q.variant)}
           and ${condition(targetExpr, node.op, node.value)})`;
    }
  }
}

/** Keyset: rows strictly after the cursor in (sort keys…, entry id, locale) order, nulls last. */
function afterCursor(exprs: Expr[], dirs: Array<"asc" | "desc">, values: CursorValue[]): RawBuilder<unknown> {
  const ors: RawBuilder<unknown>[] = [];
  for (let i = 0; i < exprs.length; i += 1) {
    const equalBefore = exprs.slice(0, i).map((expr, j) => (values[j] === null ? sql`${expr.sql} is null` : sql`${expr.sql} = ${castValue(values[j] as FilterScalar, expr.pgType)}`));
    const v = values[i];
    if (v === null) continue; // nulls sort last: nothing is strictly after a null at this key
    const cmp = dirs[i] === "asc" ? sql`${exprs[i].sql} > ${castValue(v, exprs[i].pgType)}` : sql`${exprs[i].sql} < ${castValue(v, exprs[i].pgType)}`;
    const strict = exprs[i].nullable ? sql`(${exprs[i].sql} is null or ${cmp})` : cmp;
    ors.push(equalBefore.length ? sql`(${sql.join([...equalBefore, strict], sql` and `)})` : strict);
  }
  return ors.length ? sql`(${sql.join(ors, sql` or `)})` : sql`false`;
}

function normaliseSortValue(field: ResolvedField, value: unknown): CursorValue {
  if (value === null || value === undefined) return null;
  if ((field.type === "number" || field.type === "integer") && typeof value === "string") return Number(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

/** Runs one items query. `db` should be the request's read transaction (statement_timeout set). */
export async function runItemsQuery(db: DbExecutor, q: ItemsQuery): Promise<ItemRow[]> {
  const source = q.model.source;
  if (!source && needsTable(q)) throw new ItemsApiError("MODEL_TABLE_NOT_READY", "This model's table is being updated; filtering, sorting and search are back shortly");
  const path: "table" | "snapshot" = source ? "table" : "snapshot";

  const sortFields: ResolvedField[] = q.sort.map((key) => key.resolved);
  const sortExprs = sortFields.map((field) => fieldExpr(field, source, "r", path));
  const dirs = q.sort.map((key) => key.direction);
  // Tiebreak: entry id, then locale (table rows), always ascending.
  const tieExprs: Expr[] = [systemExpr("id", path), ...(path === "table" ? [systemExpr("locale", path)] : [])];
  const allExprs = [...sortExprs, ...tieExprs];
  const allDirs: Array<"asc" | "desc"> = [...dirs, ...tieExprs.map(() => "asc" as const)];
  const orderBy = sql.join(allExprs.map((expr, i) => sql`${expr.sql} ${allDirs[i] === "asc" ? sql`asc` : sql`desc`} nulls last`));

  const where: RawBuilder<unknown>[] = [
    sql`${ref("e", "workspace_id")} = ${q.workspaceId}`,
    sql`${ref("e", "content_model_id")} = ${q.model.id}`,
    entryVisible("e", q.variant),
  ];
  if (q.entryIds) where.push(q.entryIds.length ? sql`${ref("e", "id")} = any(cast(${[...q.entryIds]} as uuid[]))` : sql`false`);
  if (q.locale) where.push(sql`${systemExpr("locale", path).sql} = ${q.locale}`);
  if (q.filter) where.push(compileFilter(q.filter, q, path, { n: 0 }));
  if (q.search) {
    const columns = q.search.fields
      .map((field) => (source ? columnOf(source, field.key) : null))
      .filter((column): column is ColumnShape => Boolean(column) && column!.pgType === "text" && SEARCHABLE_TYPES.has(column!.fieldType));
    where.push(columns.length
      ? sql`(${sql.join(columns.map((column) => sql`${ref("r", column.name)} ilike ${likePattern(q.search!.term)} escape '\\'`), sql` or `)})`
      : sql`false`);
  }
  if (q.after) {
    const values: CursorValue[] = [...q.after.k, q.after.id, ...(path === "table" ? [q.after.l ?? ""] : [])];
    where.push(afterCursor(allExprs, allDirs, values));
  }
  const sortValuesSelect = sortExprs.length ? sql`jsonb_build_array(${sql.join(sortExprs.map((expr) => expr.sql))})` : sql`'[]'::jsonb`;

  if (source) {
    const table = tableRef(source);
    const { rows } = await sql<{ entry_id: string; locale: string; variant: Variant; row: Record<string, unknown>; snapshot: Record<string, unknown> | null; version: number | null; created_at: string; updated_at: string; published_at: string | null; sort_values: unknown[] }>`
      select ${ref("r", STORAGE_COLUMNS.entryId)} as entry_id, ${ref("r", STORAGE_COLUMNS.locale)} as locale, ${ref("r", STORAGE_COLUMNS.variant)} as variant,
             to_jsonb(r) as row, ${source.snapshotKeys.length ? sql`vv.data_jsonb` : sql`null::jsonb`} as snapshot,
             vv.version_number as version, e.created_at, e.updated_at, pv.created_at as published_at, ${sortValuesSelect} as sort_values
        from ${table} r
        join public.content_entries e on e.id = ${ref("r", STORAGE_COLUMNS.entryId)}
        left join public.content_entry_versions vv
          on vv.id = case when ${ref("r", STORAGE_COLUMNS.variant)} = 'draft' then e.current_draft_version_id else e.published_version_id end and vv.entry_id = e.id
        left join public.content_entry_versions pv on pv.id = e.published_version_id and pv.entry_id = e.id
       where ${variantRow(table, "r", q.variant)} and ${sql.join(where, sql` and `)}
       order by ${orderBy}
       limit ${q.limit}`.execute(db);
    return rows.map((row) => {
      const snapshot = row.snapshot && typeof row.snapshot === "object"
        ? Object.fromEntries(source.snapshotKeys.filter((key) => key in row.snapshot!).map((key) => [key, row.snapshot![key]]))
        : null;
      return {
        entryId: row.entry_id,
        locale: row.locale,
        variant: q.variant,
        version: Number(row.version ?? 0),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        data: rowToData(source.shape, row.row, snapshot, source.fieldKeys),
        sortValues: (row.sort_values ?? []).map((value, i) => normaliseSortValue(sortFields[i], value)),
      };
    });
  }

  const pointer = q.variant === "published" ? sql`e.published_version_id` : sql`coalesce(e.current_draft_version_id, e.published_version_id)`;
  const { rows } = await sql<{ entry_id: string; locale: string; data: Record<string, unknown>; version: number; created_at: string; updated_at: string; published_at: string | null; sort_values: unknown[] }>`
    select e.id as entry_id, vv.locale, vv.data_jsonb as data, vv.version_number as version, e.created_at, e.updated_at,
           pv.created_at as published_at, ${sortValuesSelect} as sort_values
      from public.content_entries e
      join public.content_entry_versions vv on vv.id = ${pointer} and vv.entry_id = e.id
      left join public.content_entry_versions pv on pv.id = e.published_version_id and pv.entry_id = e.id
     where ${sql.join(where, sql` and `)}
     order by ${orderBy}
     limit ${q.limit}`.execute(db);
  return rows.map((row) => ({
    entryId: row.entry_id,
    locale: row.locale,
    variant: q.variant,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    data: row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {},
    sortValues: (row.sort_values ?? []).map((value, i) => normaliseSortValue(sortFields[i], value)),
  }));
}

export { SYSTEM_SORTABLE };
