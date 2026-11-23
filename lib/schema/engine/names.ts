// Name rules for anything that becomes a PostgreSQL identifier: model api keys, field keys (column
// names), table names and derived index/constraint names. Identifiers are always passed to SQL through
// Kysely's sql.id() (quoted), never concatenated; these rules are the second line of defence and keep
// names portable and predictable.
import { createHash } from "node:crypto";
import type { PlanProblem } from "@/lib/schema/engine/plan";

/** Model api keys and field keys: lowercase letter first, then lowercase letters, digits, underscores; 63 bytes max. */
export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * PostgreSQL's reserved key words (pg_get_keywords() categories R and T, PostgreSQL 15 to 17). A
 * dual test checks this list still covers every R and T word of the test database's version.
 */
export const POSTGRES_RESERVED_WORDS: ReadonlySet<string> = new Set([
  // R: reserved
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "both", "case", "cast",
  "check", "collate", "column", "constraint", "create", "current_catalog", "current_date", "current_role",
  "current_time", "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct", "do",
  "else", "end", "except", "false", "fetch", "for", "foreign", "from", "grant", "group", "having", "in",
  "initially", "intersect", "into", "lateral", "leading", "limit", "localtime", "localtimestamp", "not",
  "null", "offset", "on", "only", "or", "order", "placing", "primary", "references", "returning", "select",
  "session_user", "some", "symmetric", "system_user", "table", "then", "to", "trailing", "true", "union",
  "unique", "user", "using", "variadic", "when", "where", "window", "with",
  // T: reserved, but allowed as a function or type name
  "authorization", "binary", "collation", "concurrently", "cross", "current_schema", "freeze", "full",
  "ilike", "inner", "is", "isnull", "join", "left", "like", "natural", "notnull", "outer", "overlaps",
  "right", "similar", "tablesample", "verbose",
]);

/** Prefixes PostgreSQL or this CMS use for their own objects. */
export const SYSTEM_PREFIXES = ["pg_", "polynovea_"] as const;

/** PostgreSQL's hidden system columns: a field with one of these names would be shadowed or refused. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(["tableoid", "xmin", "cmin", "xmax", "cmax", "ctid", "oid"]);

/** The storage columns every model table has, plus `id`, which the API uses for the entry id. */
export const STORAGE_COLUMNS: ReadonlySet<string> = new Set(["entry_id", "variant", "locale", "id"]);

export type NameKind = "model" | "field";

const KIND_LABEL: Record<NameKind, string> = { model: "Model API key", field: "Field key" };

/** Why `name` cannot be used, or null if it can. Messages are plain words, safe to show in the UI. */
export function nameProblem(name: string, kind: NameKind): PlanProblem | null {
  const label = KIND_LABEL[kind];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return {
      code: "invalid_name",
      message: `${label} "${String(name).slice(0, 80)}" must start with a lowercase letter and use only lowercase letters, digits and underscores (63 characters at most).`,
    };
  }
  if (POSTGRES_RESERVED_WORDS.has(name)) {
    return { code: "reserved_word", message: `${label} "${name}" is a reserved database word. Choose another name, for example "${name}_value".` };
  }
  const prefix = SYSTEM_PREFIXES.find((p) => name.startsWith(p));
  if (prefix) return { code: "system_name", message: `${label} "${name}" starts with "${prefix}", which is kept for the system.` };
  if (kind === "field" && (SYSTEM_COLUMNS.has(name) || STORAGE_COLUMNS.has(name))) {
    return { code: "system_name", message: `Field key "${name}" is used by the system for every model. Choose another name.` };
  }
  return null;
}

/** Physical table names: the fixed m_ prefix keeps them apart from anything a user names. */
export const TABLE_NAME_PATTERN = /^m_[a-z0-9_]{1,61}$/;

/** Every identifier the engine renders: user names, table names and derived names. */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Throws unless `name` is safe to render as an identifier. Called for every identifier in render.ts. */
export function assertIdentifier(name: string): string {
  if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name)) throw new Error(`Unsafe SQL identifier refused: ${JSON.stringify(String(name).slice(0, 80))}`);
  return name;
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
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
