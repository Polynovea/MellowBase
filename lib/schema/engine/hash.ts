// Stable hashes: SHA-256 of canonical JSON (object keys sorted at every depth by their UTF-8 bytes,
// undefined values dropped, array order kept, no whitespace). The same value always hashes the same,
// whatever order its keys were written in, and any change to any nested value changes the hash.
//
// The SQL function public.polynovea_canonical_json(jsonb) (migration 0075) produces the same text for
// a schema stored as jsonb, so the database can re-hash stored schemas; a dual test keeps the two equal.
import { createHash } from "node:crypto";
import type { CanonicalSchema } from "@/lib/schema/fields/types";
import type { SchemaHash, TableShape } from "@/lib/schema/engine/plan";

/** UTF-8 byte order: the same order as PostgreSQL's `collate "C"`. */
function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** JSON with object keys sorted at every depth. Throws on values JSON cannot represent faithfully. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => compareKeys(a, b));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot encode ${typeof value}`);
  }
}

export function hashCanonical(value: unknown): SchemaHash {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Hash of a table's physical shape; null (no table yet) has its own fixed hash. */
export function hashShape(shape: TableShape | null): SchemaHash {
  return hashCanonical({ shape });
}

/**
 * The schema hash used everywhere (content_model_versions.schema_hash, plans, and the SDK later):
 * the canonical JSON of the schema exactly as it is stored, i.e. after a JSON round trip, which is
 * what PostgreSQL holds in schema_json.
 */
export function hashModelSchema(schema: CanonicalSchema): SchemaHash {
  return hashCanonical(JSON.parse(JSON.stringify(schema)));
}
