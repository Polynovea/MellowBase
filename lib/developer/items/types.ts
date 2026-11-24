/**
 * The generated items API (Phase 4): shared contract.
 *
 * `/api/v1/models/{model}/items` and `/api/v1/models/{model}/items/{id}`, one set of generic handlers
 * driven by each model's metadata. This file is the contract the typed SDK (Phase 4 wave 2) builds on:
 * wire shapes, the filter grammar, the operator table, error codes and the hard limits. It has no
 * runtime dependencies, so the SDK and the CLI can import it as is.
 *
 * Design: side-session note p4-w1-api-design.md (lead OK, 24 Nov 2026).
 */
import type { FieldType } from "@/lib/schema/fields/types";

// ---------------------------------------------------------------------------------------------------
// Routes, headers, parameters

export const ITEMS_API_PREFIX = "/api/v1/models";
export const itemsPath = (modelApiKey: string) => `${ITEMS_API_PREFIX}/${modelApiKey}/items`;
export const itemPath = (modelApiKey: string, id: string) => `${itemsPath(modelApiKey)}/${id}`;

/** Response header: the model's current schema hash (one SHA-256 across the system, Phase 3). */
export const SCHEMA_HASH_HEADER = "x-polynovea-schema-hash";
/** Request header carrying an entry or release preview token (drafts). */
export const PREVIEW_TOKEN_HEADER = "x-polynovea-preview";
/** Token scope that reads drafts across a model (a site's preview mode). */
export const PREVIEW_SCOPE = "content.preview";

export const ITEM_LIST_PARAMS = ["filter", "sort", "search", "expand", "fields", "limit", "cursor", "locale", "variant"] as const;
export type ItemListParam = (typeof ITEM_LIST_PARAMS)[number];
export const ITEM_GET_PARAMS = ["expand", "fields", "locale", "variant"] as const;

export type Variant = "published" | "draft";

/** Every channel a field can reach a caller through; all of them ask the same access object. */
export type Channel = "output" | "filter" | "sort" | "search" | "expand" | "write" | "webhook" | "schedule" | "preview" | "mcp";

// ---------------------------------------------------------------------------------------------------
// Wire shapes

/** One item. Field values live under `data`, never mixed with system properties. */
export interface ItemRecord<TData = Record<string, unknown>> {
  id: string;
  locale: string;
  variant: Variant;
  version: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  data: TData;
}

export interface RateLimitMeta {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface ItemMeta {
  requestId: string;
  timestamp: string;
  schemaHash: string;
  rateLimit?: RateLimitMeta;
}

export interface ItemListMeta extends ItemMeta {
  page: { limit: number; nextCursor: string | null };
}

export interface ItemListResponse<TData = Record<string, unknown>> {
  data: Array<ItemRecord<TData>>;
  meta: ItemListMeta;
}

export interface ItemResponse<TData = Record<string, unknown>> {
  data: ItemRecord<TData>;
  meta: ItemMeta;
}

/** Writes: POST takes every writable field (required ones required); PATCH any subset. */
export type ItemCreateBody<TData> = Partial<TData>;
export type ItemPatchBody<TData> = Partial<TData>;

export const ITEM_ERROR_CODES = [
  "AUTH_REQUIRED",
  "INVALID_TOKEN",
  "INSUFFICIENT_SCOPE",
  "MODEL_RESTRICTED",
  "MODEL_NOT_FOUND",
  "ITEM_NOT_FOUND",
  "UNKNOWN_FIELD",
  "INVALID_FILTER",
  "INVALID_SORT",
  "INVALID_EXPAND",
  "INVALID_PARAMETER",
  "INVALID_CURSOR",
  "FILTER_TOO_DEEP",
  "FILTER_TOO_COMPLEX",
  "EXPAND_TOO_DEEP",
  "TOO_MANY_JOINS",
  "PAGE_TOO_LARGE",
  "FIELD_NOT_FILTERABLE",
  "FIELD_READ_ONLY",
  "REQUIRED_FIELD_NOT_WRITABLE",
  "VALIDATION_FAILED",
  "PREVIEW_TOKEN_REQUIRED",
  "MODEL_TABLE_NOT_READY",
  "QUERY_TIMEOUT",
  "RATE_LIMITED",
  "ITEMS_UNAVAILABLE",
] as const;
export type ItemErrorCode = (typeof ITEM_ERROR_CODES)[number];

export interface ItemErrorBody {
  error: { code: ItemErrorCode; message: string; details?: unknown };
  meta: { requestId: string; timestamp: string; rateLimit?: RateLimitMeta };
}

// ---------------------------------------------------------------------------------------------------
// Filter grammar
//
//   Filter    := Group | FieldCond
//   Group     := { "and": Filter[] } | { "or": Filter[] } | { "not": Filter }
//   FieldCond := { "<field>": OpCond } | { "<toOneRelation>": FieldCond }   (exactly one key)
//   OpCond    := { "<op>": Value }                                         (exactly one key)
//
// Sent as URL-encoded JSON in `filter`.

export const FILTER_OPERATORS = ["eq", "neq", "in", "lt", "gt", "contains", "null"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export const FILTER_GROUP_KEYS = ["and", "or", "not"] as const;

export type FilterScalar = string | number | boolean;
export type OpCondition =
  | { eq: FilterScalar } | { neq: FilterScalar } | { in: FilterScalar[] } | { lt: FilterScalar } | { gt: FilterScalar }
  | { contains: string } | { null: boolean };
export type FilterInput =
  | { and: FilterInput[] }
  | { or: FilterInput[] }
  | { not: FilterInput }
  | { [field: string]: OpCondition | FilterInput };

/** The parsed filter. `path` is field keys: one key, or a to-one relation and a field of its target. */
export type FilterNode =
  | { kind: "and"; items: FilterNode[] }
  | { kind: "or"; items: FilterNode[] }
  | { kind: "not"; item: FilterNode }
  | { kind: "cond"; path: string[]; op: FilterOperator; value: FilterScalar | FilterScalar[] | boolean };

/** System properties usable in filter and sort like fields (always readable with content.read). */
export const SYSTEM_FIELDS = {
  id: "uuid",
  createdAt: "datetime",
  updatedAt: "datetime",
  publishedAt: "datetime",
  locale: "text",
} as const;
export type SystemField = keyof typeof SYSTEM_FIELDS;

/** Which operators a field type takes. */
export type OperatorClass = "text" | "ordered" | "boolean" | "multi" | "relation" | "uuid" | "nullOnly" | "none";

export const OPERATORS_BY_CLASS: Readonly<Record<OperatorClass, readonly FilterOperator[]>> = {
  text: ["eq", "neq", "in", "contains", "null"],
  ordered: ["eq", "neq", "in", "lt", "gt", "null"],
  boolean: ["eq", "neq", "null"],
  multi: ["contains", "null"],
  relation: ["eq", "neq", "in", "null"],
  uuid: ["eq", "neq", "in"],
  nullOnly: ["null"],
  none: [],
};

const TEXT_TYPES: ReadonlySet<FieldType> = new Set(["text", "long_text", "markdown", "slug", "email", "url", "select"]);
const ORDERED_TYPES: ReadonlySet<FieldType> = new Set(["number", "integer", "date", "datetime"]);

/**
 * The operator class of a field. `columnBacked` is false for fields kept outside the model's table
 * (to-many relations): those cannot be filtered or sorted.
 */
export function operatorClassFor(type: FieldType, columnBacked: boolean): OperatorClass {
  if (!columnBacked) return "none";
  if (TEXT_TYPES.has(type)) return "text";
  if (ORDERED_TYPES.has(type)) return "ordered";
  if (type === "boolean") return "boolean";
  if (type === "multi_select") return "multi";
  if (type === "relation") return "relation";
  return "nullOnly";
}

/** Sortable: scalar, column-backed types. */
export function isSortableClass(cls: OperatorClass): boolean {
  return cls === "text" || cls === "ordered" || cls === "boolean" || cls === "uuid";
}

/** Text fields `search` matches (case-insensitive substring, pg_trgm indexes). */
export const SEARCHABLE_TYPES: ReadonlySet<FieldType> = new Set(["text", "long_text", "markdown", "slug", "email", "url", "select", "rich_text"]);

export interface SortKey {
  field: string;
  direction: "asc" | "desc";
}

/** `author,author.company` → [["author"], ["author", "company"]] */
export type ExpandPath = string[];

// ---------------------------------------------------------------------------------------------------
// Limits (per role; overrides can only lower these)

export interface ApiLimits {
  /** Largest `limit`. */
  pageSize: number;
  /** `limit` when none is given. */
  defaultPageSize: number;
  /** Nesting of and/or/not groups plus relation hops. */
  filterDepth: number;
  /** Field conditions in one filter. */
  filterConditions: number;
  /** Items in one and/or array. */
  groupItems: number;
  /** Values in one `in`. */
  inValues: number;
  /** Bytes of the `filter` parameter. */
  filterBytes: number;
  /** Levels of `expand`. */
  expandDepth: number;
  /** Distinct relation paths across filter, sort and expand. */
  joins: number;
  /** Keys in `sort`. */
  sortKeys: number;
  /** Per-request statement_timeout, in milliseconds. */
  statementTimeoutMs: number;
}

export const HARD_LIMITS: Readonly<ApiLimits> = Object.freeze({
  pageSize: 100,
  defaultPageSize: 25,
  filterDepth: 3,
  filterConditions: 20,
  groupItems: 20,
  inValues: 100,
  filterBytes: 8 * 1024,
  expandDepth: 2,
  joins: 5,
  sortKeys: 3,
  statementTimeoutMs: 5_000,
});

/** Lowest value an override may set per limit (an override below these is clamped up). */
export const MIN_LIMITS: Readonly<ApiLimits> = Object.freeze({
  pageSize: 1,
  defaultPageSize: 1,
  filterDepth: 0,
  filterConditions: 0,
  groupItems: 1,
  inValues: 1,
  filterBytes: 2,
  expandDepth: 0,
  joins: 0,
  sortKeys: 0,
  statementTimeoutMs: 1,
});

/** Search term length bounds. */
export const SEARCH_TERM = { min: 2, max: 200 } as const;
