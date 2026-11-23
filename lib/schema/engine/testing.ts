// Test helpers for the schema engine's database tests (*.dual.test.ts). Not used by the app.
import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "@/lib/db/generated/database";
import { derivedName } from "@/lib/schema/engine/names";
import type { ColumnShape, ForeignKeyAction, PgColumnType, TableShape } from "@/lib/schema/engine/plan";

/** A Kysely instance over the owner login: the role the migration worker uses for DDL. */
export function ownerDb(): Kysely<DB> {
  const url = process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL;
  if (!url) throw new Error("POLYNOVEA_TEST_POSTGRES_OWNER_URL is not set. Run node scripts/dev-db/setup.mjs");
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, ssl: false, max: 2 }) }) });
}

export const uniqueKey = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

const UDT: Record<string, PgColumnType> = {
  text: "text", jsonb: "jsonb", numeric: "numeric", int8: "bigint", bool: "boolean", date: "date", timestamptz: "timestamptz", uuid: "uuid",
};
const FK_ACTION: Record<string, ForeignKeyAction> = { r: "restrict", n: "set_null" };

type PhysicalColumn = Omit<ColumnShape, "fieldType" | "field">;

/**
 * The table as PostgreSQL's catalog describes it, in shape form (without field types, which are not
 * physical). Throws on anything the engine would never create, such as a NOT NULL field column.
 */
export async function physicalShape(query: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>, table: string): Promise<Record<string, PhysicalColumn> | null> {
  const columns = await query(
    `select column_name, udt_name, is_nullable from information_schema.columns
     where table_schema = 'content' and table_name = $1 and column_name not in ('_entry_id', '_variant', '_locale')`, [table]);
  const exists = await query("select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'content' and c.relname = $1", [table]);
  if (!exists.length) return null;
  const indexes = new Set((await query("select indexname from pg_indexes where schemaname = 'content' and tablename = $1", [table])).map((r) => String(r.indexname)));
  const constraints = new Map((await query(
    `select con.conname, con.contype, con.confdeltype, con.convalidated from pg_constraint con
     join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'content' and c.relname = $1`, [table])).map((r) => [String(r.conname), r]));
  const result: Record<string, PhysicalColumn> = {};
  for (const row of columns) {
    const name = String(row.column_name);
    if (row.is_nullable !== "YES") throw new Error(`Column ${name} is NOT NULL`);
    const pgType = UDT[String(row.udt_name)];
    if (!pgType) throw new Error(`Column ${name} has unexpected type ${String(row.udt_name)}`);
    const check = constraints.get(derivedName("ck", table, name));
    const fk = constraints.get(derivedName("fk", table, name));
    if (check && !check.convalidated) throw new Error(`Check on ${name} was left NOT VALID`);
    if (fk && !fk.convalidated) throw new Error(`Foreign key on ${name} was left NOT VALID`);
    const column: PhysicalColumn = {
      name, pgType, requiredWhenPublished: !!check, unique: indexes.has(derivedName("uq", table, name)), indexed: indexes.has(derivedName("ix", table, name)),
    };
    if (fk) column.foreignKey = { onDelete: FK_ACTION[String(fk.confdeltype)] };
    result[name] = column;
  }
  return result;
}

/** A shape without field types, for comparison with physicalShape. */
export function physicalOf(shape: TableShape | null): Record<string, PhysicalColumn> | null {
  if (!shape) return null;
  return Object.fromEntries(Object.values(shape.columns).map(({ fieldType: _fieldType, field: _field, ...rest }) => [rest.name, rest]));
}

/** Test databases keep every run's model tables, so the tests lift the install-wide model cap. */
export const TEST_LIMITS = { maxModels: 1_000_000, maxFieldsPerModel: 150, maxIndexesPerModel: 50 };
