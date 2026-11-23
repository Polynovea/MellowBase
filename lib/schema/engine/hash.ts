// Stable hashes for the schema engine: SHA-256 of canonical JSON (object keys sorted at every depth,
// undefined values dropped, array order kept). The same value always hashes the same, whatever order
// its keys were written in, and any change to any nested value changes the hash.
import { createHash } from "node:crypto";
import type { CanonicalSchema } from "@/lib/schema/fields/types";
import type { SchemaHash, TableShape } from "@/lib/schema/engine/plan";

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
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

/** Hash of a canonical model schema, covering every field and every nested setting. */
export function hashModelSchema(schema: CanonicalSchema): SchemaHash {
  return hashCanonical({ schema });
}
