// Name rules for the schema engine.
//
// Model api keys and field keys follow ONE rule, the canonical schema's (validateCanonicalSchema uses
// this same KEY_PATTERN): a lowercase letter, then lowercase letters, digits and underscores. Nothing
// else is refused, so every model that validates today can get a table unchanged.
//
// Physical names are derived from keys and stored in the table's shape: column names (see
// columnNameFor) and the m_ table names. Every identifier is quoted through Kysely's sql.id() and
// checked by assertIdentifier() before it is rendered, so reserved words are harmless as column names.
import { createHash } from "node:crypto";
import type { PlanProblem } from "@/lib/schema/engine/plan";

import { KEY_PATTERN } from "@/lib/schema/engine/keys";

export { KEY_PATTERN };

/** Physical column names: start with a letter (so never a storage column), 63 bytes at most. */
export const COLUMN_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Physical table names: the fixed m_ prefix keeps them apart from anything a user names. */
export const TABLE_NAME_PATTERN = /^m_[a-z0-9_]{1,61}$/;

/**
 * The storage columns every model table has. They start with "_", which no field key (and so no
 * derived column name) can, so a field can never collide with them. Read them from here.
 */
export const STORAGE_COLUMNS = { entryId: "_entry_id", variant: "_variant", locale: "_locale" } as const;

/** PostgreSQL's hidden system columns: a user column cannot take these names. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(["tableoid", "xmin", "cmin", "xmax", "cmax", "ctid", "oid"]);

export type NameKind = "model" | "field";

const KIND_LABEL: Record<NameKind, string> = { model: "Model API key", field: "Field key" };

/** Why `name` cannot be used as a key, or null if it can. Plain words, safe to show in the UI. */
export function nameProblem(name: string, kind: NameKind): PlanProblem | null {
  if (typeof name === "string" && KEY_PATTERN.test(name)) return null;
  return {
    code: "invalid_name",
    message: `${KIND_LABEL[kind]} "${String(name).slice(0, 80)}" must start with a lowercase letter and use only lowercase letters, digits and underscores.`,
  };
}

/** Every identifier the engine renders: column, table and derived index/constraint names. */
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Throws unless `name` is safe to render as an identifier. Called for every identifier in render.ts. */
export function assertIdentifier(name: string): string {
  if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name)) throw new Error(`Unsafe SQL identifier refused: ${JSON.stringify(String(name).slice(0, 80))}`);
  return name;
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * The column name for a new field. The key itself when it fits and is free; otherwise the key cut to
 * fit plus a hash of the key (and, on a further collision, of an attempt number). Deterministic for the
 * same key and the same set of names already taken. Once chosen, a field keeps its column name.
 */
export function columnNameFor(key: string, taken: ReadonlySet<string>): string {
  if (key.length <= 63 && !SYSTEM_COLUMNS.has(key) && !taken.has(key)) return key;
  for (let attempt = 0; ; attempt += 1) {
    const name = `${key.slice(0, 54)}_${shortHash(attempt === 0 ? key : `${key}#${attempt}`, 8)}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Table names to try for a new model, in order. The first is m_<apiKey> when it fits; the second
 * always fits and adds a hash of the workspace and api key, so two workspaces with the same api key
 * get different tables. The caller takes the first one not in use; the unique constraint on
 * content_model_tables.table_name settles any race.
 */
export function tableNameCandidates(workspaceId: string, apiKey: string): string[] {
  const hashed = `m_${apiKey.slice(0, 52)}_${shortHash(`${workspaceId}:${apiKey}`, 8)}`;
  const plain = `m_${apiKey}`;
  return plain.length <= 63 ? [plain, hashed] : [hashed];
}

export type DerivedNameKind = "uq" | "ix" | "fk" | "ck";

/**
 * The name of a column's index or constraint. Index names share one namespace per schema, so the name
 * hashes table and column: unique, deterministic, and always a valid identifier.
 */
export function derivedName(kind: DerivedNameKind, table: string, column: string): string {
  return `${kind}_${shortHash(`${table}.${column}`, 24)}`;
}
