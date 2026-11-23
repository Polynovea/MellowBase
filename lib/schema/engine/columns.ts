// From the canonical schema to physical columns: the compiler contract's "PostgreSQL migration
// intent" made concrete. One field becomes at most one column; to-many relations have none. Column
// names are derived from field keys once (columnNameFor) and then kept in the table's shape.
import { FIELD_TYPE_REGISTRY } from "@/lib/schema/fields/registry";
import type { CanonicalSchema, FieldDefinition, RelationConfig } from "@/lib/schema/fields/types";
import { columnNameFor } from "@/lib/schema/engine/names";
import { PG_COLUMN_TYPES, type ColumnShape, type ForeignKeyAction, type PgColumnType, type TableShape } from "@/lib/schema/engine/plan";

const PG_TYPES: ReadonlySet<string> = new Set(PG_COLUMN_TYPES);

export function isPgColumnType(value: unknown): value is PgColumnType {
  return typeof value === "string" && PG_TYPES.has(value);
}

/** The FK action for a relation's onDelete. "archive_dependents" is app logic, so the database blocks. */
export const FOREIGN_KEY_ACTIONS: Record<RelationConfig["onDelete"], ForeignKeyAction> = {
  block: "restrict",
  remove_reference: "set_null",
  archive_dependents: "restrict",
};

/** True for a relation that holds one target per entry, stored as a uuid column with a foreign key. */
export function isToOneRelation(field: FieldDefinition): boolean {
  return field.type === "relation" && (field.relation?.cardinality === "many_to_one" || field.relation?.cardinality === "one_to_one");
}

/** True for a field stored outside the model table (to-many relations stay in content_relations). */
export function hasNoColumn(field: FieldDefinition): boolean {
  return field.type === "relation" && !!field.relation && !isToOneRelation(field);
}

/**
 * A field's column (named `columnName`), or null if it has none. A relation without a target (which
 * the canonical schema allows) is a plain uuid column with no foreign key. Throws for an unmapped type.
 */
export function columnForField(field: FieldDefinition, columnName: string): ColumnShape | null {
  if (hasNoColumn(field)) return null;
  const pgType = FIELD_TYPE_REGISTRY[field.type]?.postgresType;
  if (!isPgColumnType(pgType)) throw new Error(`Field type "${field.type}" has no column type.`);

  const toOne = isToOneRelation(field);
  const unique = Boolean(field.unique) || field.relation?.cardinality === "one_to_one";
  const column: ColumnShape = {
    name: columnName,
    field: field.key,
    fieldType: field.type,
    pgType,
    requiredWhenPublished: Boolean(field.required),
    unique,
    // A unique index already serves lookups; relation columns are always indexed (joins and the FK check).
    indexed: !unique && (Boolean(field.index) || field.type === "relation"),
  };
  if (toOne && field.relation) column.foreignKey = { onDelete: FOREIGN_KEY_ACTIONS[field.relation.onDelete] };
  return column;
}

/** The column that holds field `key` in `shape`, if any. */
export function columnOfField(shape: TableShape | null | undefined, key: string): ColumnShape | undefined {
  return Object.values(shape?.columns ?? {}).find((column) => column.field === key);
}

/**
 * The table `schema` compiles to, given the table as it is now. Fields that already have a column keep
 * its name; a renamed field's column takes a name derived from its new key; new fields get a derived
 * name that no current or newly assigned column uses. Deterministic for the same inputs.
 */
export function shapeForSchema(
  table: string,
  schema: CanonicalSchema,
  current: TableShape | null = null,
  renames: readonly { from: string; to: string }[] = [],
): TableShape {
  const taken = new Set(Object.keys(current?.columns ?? {}));
  const renamedFrom = new Map(renames.map((rename) => [rename.to, rename.from]));
  const assigned = new Map<string, string>();
  // Kept fields first, then renamed ones, then new ones, so names never depend on field order alone.
  for (const field of schema.fields) {
    const existing = !renamedFrom.has(field.key) ? columnOfField(current, field.key) : undefined;
    if (existing) assigned.set(field.key, existing.name);
  }
  for (const field of schema.fields) {
    const from = renamedFrom.get(field.key);
    const old = from !== undefined ? columnOfField(current, from) : undefined;
    if (!old) continue;
    taken.delete(old.name);
    const name = columnNameFor(field.key, taken);
    taken.add(name);
    assigned.set(field.key, name);
  }
  const columns: Record<string, ColumnShape> = {};
  for (const field of schema.fields) {
    if (hasNoColumn(field)) continue;
    let name = assigned.get(field.key);
    if (name === undefined) {
      name = columnNameFor(field.key, taken);
      taken.add(name);
    }
    const column = columnForField(field, name);
    if (column) columns[column.name] = column;
  }
  return { table, columns };
}

/** Indexes a column has (unique or plain); counted against the per-model index cap. */
export function indexCount(shape: TableShape): number {
  return Object.values(shape.columns).filter((column) => column.unique || column.indexed).length;
}

/**
 * Whether every value of type `from` converts to `to` without loss, in place. Anything else is a
 * replace (drop and re-add), which deletes the values and is destructive.
 */
export function isLosslessTypeChange(from: PgColumnType, to: PgColumnType): boolean {
  if (from === to) return true;
  if (to === "text" || to === "jsonb") return true;
  if (from === "bigint" && to === "numeric") return true;
  if (from === "date" && to === "timestamptz") return true;
  return false;
}
