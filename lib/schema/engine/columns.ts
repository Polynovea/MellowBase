// From the canonical schema to physical columns: the compiler contract's "PostgreSQL migration
// intent" made concrete. One field becomes at most one column; to-many relations have none.
import { FIELD_TYPE_REGISTRY } from "@/lib/schema/fields/registry";
import type { CanonicalSchema, FieldDefinition, RelationConfig } from "@/lib/schema/fields/types";
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

/** True for a relation that holds one target per entry, stored as a uuid column. */
export function isToOneRelation(field: FieldDefinition): boolean {
  return field.type === "relation" && (field.relation?.cardinality === "many_to_one" || field.relation?.cardinality === "one_to_one");
}

/** True for a field stored outside the model table (to-many relations stay in content_relations). */
export function hasNoColumn(field: FieldDefinition): boolean {
  return field.type === "relation" && !!field.relation && !isToOneRelation(field);
}

/** A field's column, or null if it has none. Throws for a relation without a target, or an unmapped type. */
export function columnForField(field: FieldDefinition): ColumnShape | null {
  if (field.type === "relation" && !field.relation) throw new Error(`Relation field "${field.key}" has no target model.`);
  if (hasNoColumn(field)) return null;
  const pgType = FIELD_TYPE_REGISTRY[field.type]?.postgresType;
  if (!isPgColumnType(pgType)) throw new Error(`Field type "${field.type}" has no column type.`);

  const toOne = isToOneRelation(field);
  const unique = Boolean(field.unique) || field.relation?.cardinality === "one_to_one";
  const column: ColumnShape = {
    name: field.key,
    fieldType: field.type,
    pgType,
    requiredWhenPublished: Boolean(field.required),
    unique,
    // A unique index already serves lookups; relation columns are always indexed (joins and the FK check).
    indexed: !unique && (Boolean(field.index) || toOne),
  };
  if (toOne && field.relation) column.foreignKey = { onDelete: FOREIGN_KEY_ACTIONS[field.relation.onDelete] };
  return column;
}

/** The table a schema compiles to. */
export function shapeForSchema(table: string, schema: CanonicalSchema): TableShape {
  const columns: Record<string, ColumnShape> = {};
  for (const field of schema.fields) {
    const column = columnForField(field);
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
