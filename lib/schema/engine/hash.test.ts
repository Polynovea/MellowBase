import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical, hashModelSchema, hashShape } from "@/lib/schema/engine/hash";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

const schema = (fields: CanonicalSchema["fields"]): CanonicalSchema => ({ name: "Post", apiKey: "post", fields });
const field = (key: string, type: CanonicalSchema["fields"][number]["type"] = "text") => ({ key, label: key, type, required: false, localized: false, unique: false });

describe("schema hashes", () => {
  it("are stable whatever order keys were written in", () => {
    expect(hashCanonical({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(hashCanonical({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("change when any nested value changes", () => {
    expect(hashModelSchema(schema([field("title")]))).not.toBe(hashModelSchema(schema([field("headline")])));
    expect(hashModelSchema(schema([field("title")]))).not.toBe(hashModelSchema(schema([field("title", "long_text")])));
    expect(hashModelSchema(schema([{ ...field("title"), validation: { maxLength: 10 } }])))
      .not.toBe(hashModelSchema(schema([{ ...field("title"), validation: { maxLength: 11 } }])));
  });

  it("keep array order (field order is meaningful) and drop undefined values", () => {
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
    expect(hashCanonical({ a: 1, b: undefined })).toBe(hashCanonical({ a: 1 }));
  });

  it("are 64 hex characters, with a fixed hash for 'no table yet'", () => {
    expect(hashShape(null)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShape(null)).toBe(hashShape(null));
    expect(hashShape({ table: "m_post", columns: {} })).not.toBe(hashShape(null));
  });

  it("refuses values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(BigInt(1))).toThrow();
  });
});
