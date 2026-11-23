// SQL for each plan step. Every identifier goes through assertIdentifier() and then Kysely's sql.id()
// (double-quoted); column types and FK actions come from fixed maps, never from input; the only value
// (a backfill default) is a bound parameter. Nothing user-supplied is concatenated into SQL.
import { sql, type RawBuilder } from "kysely";
import { isPgColumnType } from "@/lib/schema/engine/columns";
import { assertIdentifier, derivedName, STORAGE_COLUMNS, TABLE_NAME_PATTERN } from "@/lib/schema/engine/names";
import type { ColumnShape, ForeignKeyAction, PgColumnType, PlanStep, RenderedStatement } from "@/lib/schema/engine/plan";

export const CONTENT_SCHEMA = "content";
export const APP_ROLE = "polynovea_app";
export const APP_POLICY = "polynovea_app_all";

export interface RenderOptions {
  /** Build and drop indexes CONCURRENTLY, outside a transaction (default true, for the runner). The reference executor and tests set false. */
  concurrentIndexes?: boolean;
}

export function tableRef(table: string): RawBuilder<unknown> {
  if (!TABLE_NAME_PATTERN.test(table)) throw new Error(`Unsafe model table name refused: ${JSON.stringify(table.slice(0, 80))}`);
  return sql.id(CONTENT_SCHEMA, table);
}

export const ident = (name: string) => sql.id(assertIdentifier(name));
const indexRef = (name: string) => sql.id(CONTENT_SCHEMA, assertIdentifier(name));

function pgType(type: PgColumnType): RawBuilder<unknown> {
  if (!isPgColumnType(type)) throw new Error(`Unknown column type refused: ${JSON.stringify(String(type))}`);
  return sql.raw(type);
}

const FK_ACTION_SQL: Record<ForeignKeyAction, string> = { restrict: "restrict", set_null: "set null" };

/** How an existing value converts in a lossless change_type. */
function usingExpression(column: string, from: PgColumnType, to: PgColumnType): RawBuilder<unknown> {
  const col = ident(column);
  if (to === "jsonb") return sql`to_jsonb(${col})`;
  if (to === "text" && from === "jsonb") return sql`${col} #>> '{}'`;
  return sql`${col}::${pgType(to)}`;
}

const tx = (query: RawBuilder<unknown>, lockSensitive = true, ownTransaction = false): RenderedStatement => ({ sql: query, transactional: true, lockSensitive, ownTransaction });

function columnDefinition(column: ColumnShape): RawBuilder<unknown> {
  return sql`${ident(column.name)} ${pgType(column.pgType)}`;
}

/** The bound value for a backfill, cast to the column type. */
function backfillValue(value: unknown, type: PgColumnType): RawBuilder<unknown> {
  const text = type === "jsonb" ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value);
  return sql`cast(${text} as ${pgType(type)})`;
}

export function renderStep(step: PlanStep, options: RenderOptions = {}): RenderedStatement[] {
  const concurrently = options.concurrentIndexes !== false;
  const table = tableRef(step.table);
  switch (step.kind) {
    case "create_table": {
      const columns = step.columns.map(columnDefinition);
      const fieldColumns = columns.length ? sql`, ${sql.join(columns, sql`, `)}` : sql``;
      // The entry foreign key is added after the table exists, as NOT VALID and then VALIDATE, each in
      // its own transaction: adding it takes SHARE ROW EXCLUSIVE on content_entries, so it must be short
      // and retried under lock_timeout, not held while the rest of the table is created.
      const entryFk = ident(derivedName("fk", step.table, STORAGE_COLUMNS.entryId));
      return [
        tx(sql`create table ${table} (
          _entry_id uuid not null,
          _variant text not null check (_variant in ('draft', 'published')),
          _locale text not null${fieldColumns},
          primary key (_entry_id, _variant, _locale)
        )`, false),
        tx(sql`grant select, insert, update, delete on ${table} to ${sql.id(APP_ROLE)}`, false),
        tx(sql`alter table ${table} enable row level security`, false),
        tx(sql`create policy ${sql.id(APP_POLICY)} on ${table} for all to ${sql.id(APP_ROLE)} using (true) with check (true)`, false),
        tx(sql`alter table ${table} add constraint ${entryFk} foreign key (_entry_id) references public.content_entries (id) on delete cascade not valid`, true, true),
        tx(sql`alter table ${table} validate constraint ${entryFk}`, false, true),
      ];
    }
    case "drop_table":
      return [tx(sql`drop table ${table}`)];
    case "add_column":
      return [tx(sql`alter table ${table} add column ${columnDefinition(step.column)}`)];
    case "drop_column":
      return [tx(sql`alter table ${table} drop column ${ident(step.column)}`)];
    case "rename_column": {
      if (step.from === step.to) return [];
      const statements = [tx(sql`alter table ${table} rename column ${ident(step.from)} to ${ident(step.to)}`)];
      const renameIndex = (kind: "uq" | "ix" | "tg") =>
        tx(sql`alter index ${indexRef(derivedName(kind, step.table, step.from))} rename to ${ident(derivedName(kind, step.table, step.to))}`);
      const renameConstraint = (kind: "ck" | "fk") =>
        tx(sql`alter table ${table} rename constraint ${ident(derivedName(kind, step.table, step.from))} to ${ident(derivedName(kind, step.table, step.to))}`);
      if (step.column.unique) statements.push(renameIndex("uq"));
      if (step.column.indexed) statements.push(renameIndex("ix"));
      if (step.column.searchIndexed) statements.push(renameIndex("tg"));
      if (step.column.requiredWhenPublished) statements.push(renameConstraint("ck"));
      if (step.column.foreignKey) statements.push(renameConstraint("fk"));
      return statements;
    }
    case "change_type":
      return [tx(sql`alter table ${table} alter column ${ident(step.column)} type ${pgType(step.to)} using ${usingExpression(step.column, step.from, step.to)}`)];
    case "change_field_type":
    case "drop_field_metadata":
      return [];
    case "replace_column":
      return [
        tx(sql`alter table ${table} drop column ${ident(step.column.name)}`),
        tx(sql`alter table ${table} add column ${columnDefinition(step.column)}`),
      ];
    case "backfill_column":
      return [tx(sql`update ${table} set ${ident(step.column)} = ${backfillValue(step.value, step.pgType)} where ${ident(step.column)} is null`, false, true)];
    case "set_required": {
      const name = ident(derivedName("ck", step.table, step.column));
      return [
        tx(sql`alter table ${table} add constraint ${name} check (_variant <> 'published' or ${ident(step.column)} is not null) not valid`),
        // VALIDATE takes a SHARE UPDATE EXCLUSIVE lock: reads and writes continue during the scan.
        tx(sql`alter table ${table} validate constraint ${name}`, false, true),
      ];
    }
    case "drop_required":
      return [tx(sql`alter table ${table} drop constraint ${ident(derivedName("ck", step.table, step.column))}`)];
    case "add_index": {
      const name = ident(derivedName(step.unique ? "uq" : "ix", step.table, step.column));
      const columns = step.unique ? sql`(${ident(step.column)}, _variant, _locale)` : sql`(${ident(step.column)})`;
      const query = sql`create ${sql.raw(step.unique ? "unique index" : "index")} ${sql.raw(concurrently ? "concurrently " : "")}${name} on ${table} ${columns}`;
      return [{ sql: query, transactional: !concurrently, lockSensitive: !concurrently, ownTransaction: false }];
    }
    case "drop_index": {
      const name = indexRef(derivedName(step.unique ? "uq" : "ix", step.table, step.column));
      const query = sql`drop index ${sql.raw(concurrently ? "concurrently " : "")}${name}`;
      return [{ sql: query, transactional: !concurrently, lockSensitive: !concurrently, ownTransaction: false }];
    }
    case "add_search_index": {
      // gin_trgm_ops is pg_trgm's (migration 0017; 0076 notes where it must be installed).
      const name = ident(derivedName("tg", step.table, step.column));
      const query = sql`create index ${sql.raw(concurrently ? "concurrently " : "")}${name} on ${table} using gin (${ident(step.column)} gin_trgm_ops)`;
      return [{ sql: query, transactional: !concurrently, lockSensitive: !concurrently, ownTransaction: false }];
    }
    case "drop_search_index": {
      const query = sql`drop index ${sql.raw(concurrently ? "concurrently " : "")}${indexRef(derivedName("tg", step.table, step.column))}`;
      return [{ sql: query, transactional: !concurrently, lockSensitive: !concurrently, ownTransaction: false }];
    }
    case "add_foreign_key": {
      if (!Object.prototype.hasOwnProperty.call(FK_ACTION_SQL, step.onDelete)) throw new Error(`Unknown foreign key action refused: ${JSON.stringify(String(step.onDelete))}`);
      const name = ident(derivedName("fk", step.table, step.column));
      return [
        tx(sql`alter table ${table} add constraint ${name} foreign key (${ident(step.column)}) references public.content_entries (id) on delete ${sql.raw(FK_ACTION_SQL[step.onDelete])} not valid`, true, true),
        tx(sql`alter table ${table} validate constraint ${name}`, false, true),
      ];
    }
    case "drop_foreign_key":
      return [tx(sql`alter table ${table} drop constraint ${ident(derivedName("fk", step.table, step.column))}`)];
  }
}
