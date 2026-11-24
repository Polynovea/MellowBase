/**
 * Schema drift for the typed SDK (Phase 4 wave 2).
 *
 * The SDK sends `x-polynovea-schema-hash` with the model hash its types were pulled from. When that
 * differs from the model's current hash, the items handler (W1) calls `schemaChangeHeaders`, which
 * answers with:
 *
 *   x-polynovea-schema-change: minor | major | unknown
 *   x-polynovea-schema-fields: the caller's currently readable field keys (comma-separated)
 *
 * No leaks: both versions are seen ONLY through the caller's current access, so a change to a field the
 * caller cannot read changes nothing they can see and gives `minor`. A field that no longer exists has
 * lost its permission rows with it (migration 0073), so the server cannot tell whether this caller could
 * ever read it; the server therefore never reports removals. The SDK finds them itself by comparing the
 * readable fields in its types file with `x-polynovea-schema-fields`, which lists only what the caller
 * can read now (the same keys its item responses already show).
 *
 * `unknown`: the hash is malformed, or is not one of this model's versions in this workspace. Both give
 * the same answer, so a caller cannot probe other workspaces' version history.
 */
import { createHash } from "node:crypto";
import type { CanonicalSchema } from "@/lib/schema/fields/types";
import { buildItemsOpenApi, componentName, type OpenApiModelInput } from "@/lib/developer/items/openapi";

export const SCHEMA_CHANGE_HEADER = "x-polynovea-schema-change";
export const SCHEMA_FIELDS_HEADER = "x-polynovea-schema-fields";

export type SchemaChange = "minor" | "major";
export type SchemaChangeSignal = SchemaChange | "unknown";

export interface SchemaChangeResult {
  change: SchemaChange;
  /** Why it is major, in terms of the caller's own view (never a field it cannot read). For logs and tests. */
  reasons: string[];
}

type Json = Record<string, unknown>;

/** Schema keywords that change validation only, not the shape a client compiles against. */
const VALIDATION_ONLY = new Set(["title", "description", "minLength", "maxLength", "minimum", "maximum", "pattern"]);

function strip(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strip);
  if (!schema || typeof schema !== "object") return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) {
    if (VALIDATION_ONLY.has(key) || key === "enum" || key === "x-polynovea-filter-ops") continue;
    out[key] = strip(value);
  }
  return out;
}

const enumOf = (schema: Json | undefined): unknown[] | null => {
  if (!schema) return null;
  if (Array.isArray(schema.enum)) return schema.enum as unknown[];
  const items = schema.items as Json | undefined;
  return items && Array.isArray(items.enum) ? (items.enum as unknown[]) : null;
};
const lost = <T>(before: readonly T[], after: readonly T[]) => before.filter((value) => !after.includes(value));

/** One model's view for one caller, as the items OpenAPI shows it. */
function viewOf(input: OpenApiModelInput) {
  const doc = buildItemsOpenApi([input]);
  const C = componentName(input.apiKey);
  const props = (name: string) => ((doc.schemas[`${C}${name}`] as Json | undefined)?.properties ?? {}) as Record<string, Json>;
  const create = doc.schemas[`${C}Create`] as Json | undefined;
  return {
    data: props("Data"),
    create: props("Create"),
    required: Array.isArray(create?.required) ? (create!.required as string[]) : [],
    conditions: Object.keys(props("FieldCondition")),
    sort: ((doc.schemas[`${C}SortKey`] as Json | undefined)?.enum ?? []) as string[],
  };
}

/**
 * Classify the change from `previous` to `current` as the caller sees it. Both are seen through
 * `current`'s readable and writable sets, so a field the caller cannot read now is absent from both.
 * Fields that only exist in `previous` are left out on purpose (see the file comment).
 */
export function classifyItemsSchemaChange(previous: CanonicalSchema, current: OpenApiModelInput): SchemaChangeResult {
  const before = viewOf({ ...current, schema: previous });
  const after = viewOf(current);
  const reasons: string[] = [];

  for (const [key, was] of Object.entries(before.data)) {
    const now = after.data[key];
    if (!now) continue; // cannot happen (`before` is filtered by the current readable set); removals are the SDK's
    if (JSON.stringify(strip(was)) !== JSON.stringify(strip(now))) reasons.push(`${key}: type changed`);
    const wasEnum = enumOf(was);
    const nowEnum = enumOf(now);
    if (wasEnum && (!nowEnum || lost(wasEnum, nowEnum).length)) reasons.push(`${key}: options removed`);
    const wasOps = (was["x-polynovea-filter-ops"] ?? []) as string[];
    const nowOps = (now["x-polynovea-filter-ops"] ?? []) as string[];
    if (lost(wasOps, nowOps).length) reasons.push(`${key}: filter operators removed (${lost(wasOps, nowOps).join(", ")})`);
  }
  for (const key of lost(after.required, before.required)) reasons.push(`${key}: now required on create`);
  // `before` only holds fields that still exist (it is filtered by the current readable set), so
  // anything lost below is a field the caller can still read that lost a capability.
  for (const key of lost(before.conditions, after.conditions)) reasons.push(`${key}: no longer filterable`);
  for (const key of lost(before.sort, after.sort)) if (!key.startsWith("-")) reasons.push(`${key}: no longer sortable`);

  return { change: reasons.length ? "major" : "minor", reasons };
}

// ---------------------------------------------------------------------------------------------------
// Response headers, memoised

const HASH = /^[0-9a-f]{64}$/;
const MEMO_LIMIT = 500;
const memo = new Map<string, SchemaChangeSignal>();

function remember(key: string, value: SchemaChangeSignal) {
  memo.delete(key);
  memo.set(key, value);
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
}

/** Two callers share a memo entry only when everything they can see and do is the same. */
export function accessFingerprint(current: OpenApiModelInput): string {
  const sorted = (set: ReadonlySet<string>) => [...set].sort().join(",");
  return createHash("sha256")
    .update(`${sorted(current.readable)}\n${sorted(current.writable)}\n${current.canWrite}\n${current.canDelete}`)
    .digest("hex");
}

export interface SchemaChangeInput {
  /** Workspace and model this request is for, e.g. `${workspaceId}:${modelId}`. Part of the memo key. */
  scope: string;
  /** The request's `x-polynovea-schema-hash`, or null. */
  requestHash: string | null;
  /** The caller's current view of the model (the same input the OpenAPI document uses). */
  current: OpenApiModelInput;
  /**
   * The model's schema at `hash`, looked up ONLY among this workspace's versions of this model
   * (content_model_versions by content_model_id and schema_hash), or null.
   */
  loadPrevious: (hash: string) => Promise<CanonicalSchema | null>;
}

/** Headers to add to an items response. Empty when the request sent no hash or the hash is current. */
export async function schemaChangeHeaders(input: SchemaChangeInput): Promise<Record<string, string>> {
  const sent = input.requestHash?.trim().toLowerCase() ?? "";
  if (!sent || sent === input.current.schemaHash) return {};
  const fields = input.current.schema.fields.filter((field) => input.current.readable.has(field.key)).map((field) => field.key).join(",");
  const headers = (signal: SchemaChangeSignal) => ({ [SCHEMA_CHANGE_HEADER]: signal, [SCHEMA_FIELDS_HEADER]: fields });
  if (!HASH.test(sent)) return headers("unknown");

  const key = `${input.scope}\n${sent}\n${input.current.schemaHash}\n${accessFingerprint(input.current)}`;
  const cached = memo.get(key);
  if (cached) {
    remember(key, cached);
    return headers(cached);
  }
  let signal: SchemaChangeSignal;
  try {
    const previous = await input.loadPrevious(sent);
    signal = previous ? classifyItemsSchemaChange(previous, input.current).change : "unknown";
  } catch {
    return headers("unknown"); // not cached: a failed lookup is retried next time
  }
  remember(key, signal);
  return headers(signal);
}

/** Tests only. */
export function schemaChangeMemoSize(): number {
  return memo.size;
}
