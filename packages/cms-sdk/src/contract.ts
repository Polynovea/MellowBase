/**
 * Wire contract of the generated items API, copied from the CMS (lib/developer/items/types.ts and
 * lib/developer/sdkTypes/drift.ts) because this package builds on its own. A parity test in the CMS
 * repository fails on any difference, so the copy cannot drift.
 */

export const ITEMS_API_PREFIX = "/api/v1/models";
export const itemsPath = (modelApiKey: string) => `${ITEMS_API_PREFIX}/${encodeURIComponent(modelApiKey)}/items`;
export const itemPath = (modelApiKey: string, id: string) => `${itemsPath(modelApiKey)}/${encodeURIComponent(id)}`;

/** Response: the model's current schema hash. Request: the hash the caller's types were pulled from. */
export const SCHEMA_HASH_HEADER = "x-polynovea-schema-hash";
/** Response, only when the two hashes differ: minor | major | unknown, as the caller sees the model. */
export const SCHEMA_CHANGE_HEADER = "x-polynovea-schema-change";
/** Response, only when the two hashes differ: the caller's currently readable field keys. */
export const SCHEMA_FIELDS_HEADER = "x-polynovea-schema-fields";
/** Request: an entry or release preview token (drafts). */
export const PREVIEW_TOKEN_HEADER = "x-polynovea-preview";

export type Variant = "published" | "draft";

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

export const FILTER_OPERATORS = ["eq", "neq", "in", "lt", "gt", "contains", "null"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterScalar = string | number | boolean;
export type OpCondition =
  | { eq: FilterScalar } | { neq: FilterScalar } | { in: FilterScalar[] } | { lt: FilterScalar } | { gt: FilterScalar }
  | { contains: string } | { null: boolean };
/** The untyped filter grammar (used when no generated types are plugged in). */
export type FilterInput =
  | { and: FilterInput[] }
  | { or: FilterInput[] }
  | { not: FilterInput }
  | { [field: string]: OpCondition | FilterInput };

/** Server hard caps (per role overrides can only lower them). */
export const HARD_LIMITS = Object.freeze({
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
