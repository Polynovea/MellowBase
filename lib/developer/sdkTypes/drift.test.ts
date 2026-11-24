import { describe, expect, it, vi } from "vitest";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";
import type { OpenApiModelInput } from "@/lib/developer/items/openapi";
import { ARTICLE_SCHEMA } from "@/lib/developer/items/testing/fixtureModels";
import {
  SCHEMA_CHANGE_HEADER,
  SCHEMA_FIELDS_HEADER,
  classifyItemsSchemaChange,
  schemaChangeHeaders,
  schemaChangeMemoSize,
} from "@/lib/developer/sdkTypes/drift";

const OLD = "a".repeat(64);
const NEW = "d".repeat(64);

const field = (key: string, type: FieldDefinition["type"], extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key, type, required: false, localized: false, unique: false, ...extra });

/** Editor view: cannot read `secret`, cannot write `rating`. */
function editor(schema: CanonicalSchema, hash = NEW): OpenApiModelInput & { readable: Set<string>; writable: Set<string> } {
  const readable = new Set(schema.fields.map((f) => f.key).filter((k) => k !== "secret"));
  const writable = new Set([...readable].filter((k) => k !== "rating"));
  return { apiKey: "article", name: "Article", schema, schemaHash: hash, readable, writable, canWrite: true, canDelete: true };
}

const withFields = (fields: FieldDefinition[]): CanonicalSchema => ({ ...ARTICLE_SCHEMA, fields });
const mapField = (key: string, change: (f: FieldDefinition) => FieldDefinition) =>
  withFields(ARTICLE_SCHEMA.fields.map((f) => (f.key === key ? change(f) : f)));

const classify = (next: CanonicalSchema) => classifyItemsSchemaChange(ARTICLE_SCHEMA, editor(next));

describe("classifyItemsSchemaChange: additive changes are minor", () => {
  it.each([
    ["no visible change", ARTICLE_SCHEMA],
    ["a new optional field", withFields([...ARTICLE_SCHEMA.fields, field("subtitle", "text")])],
    ["a new select option", mapField("status_note", (f) => ({ ...f, validation: { options: ["ok", "hold", "later"] } }))],
    ["a new multi-select option", mapField("tags", (f) => ({ ...f, validation: { options: ["news", "guide", "release", "faq"] } }))],
    ["validation only (max length)", mapField("title", (f) => ({ ...f, validation: { maxLength: 120 } }))],
    ["required becomes optional", mapField("title", (f) => ({ ...f, required: false }))],
    ["a label change", mapField("title", (f) => ({ ...f, label: "Headline" }))],
  ])("%s", (_name, next) => {
    expect(classify(next)).toEqual({ change: "minor", reasons: [] });
  });
});

describe("classifyItemsSchemaChange: breaking changes are major", () => {
  it.each([
    ["a type change", mapField("rating", (f) => ({ ...f, type: "text", validation: undefined })), "rating: type changed"],
    ["a select option removed", mapField("status_note", (f) => ({ ...f, validation: { options: ["ok"] } })), "status_note: options removed"],
    ["a field becomes required", mapField("slug", (f) => ({ ...f, required: true })), "slug: now required on create"],
    ["a new required writable field", withFields([...ARTICLE_SCHEMA.fields, field("summary", "text", { required: true })]), "summary: now required on create"],
    ["to-one becomes to-many", mapField("author", (f) => ({ ...f, relation: { ...f.relation!, cardinality: "many_to_many" } })), "author: type changed"],
    ["a relation target changes", mapField("author", (f) => ({ ...f, relation: { ...f.relation!, targetModelApiKey: "article" } })), "author: type changed"],
  ])("%s", (_name, next, reason) => {
    const result = classify(next);
    expect(result.change).toBe("major");
    expect(result.reasons).toContain(reason);
  });

  it("a field that becomes unfilterable and unsortable (to-many) is major", () => {
    const result = classify(mapField("rating", (f) => ({ ...f, type: "relation", validation: undefined, relation: { targetModelApiKey: "person", cardinality: "one_to_many", onDelete: "remove_reference" } })));
    expect(result.change).toBe("major");
    expect(result.reasons).toEqual(expect.arrayContaining(["rating: no longer filterable", "rating: no longer sortable"]));
  });

});

describe("classifyItemsSchemaChange: never leaks a hidden field", () => {
  it.each([
    ["the hidden field changes type", mapField("secret", (f) => ({ ...f, type: "integer" }))],
    ["the hidden field becomes required", mapField("secret", (f) => ({ ...f, required: true }))],
    ["the hidden field is deleted", withFields(ARTICLE_SCHEMA.fields.filter((f) => f.key !== "secret"))],
    ["a hidden field is added", withFields([...ARTICLE_SCHEMA.fields.filter((f) => f.key !== "secret"), field("secret", "text"), field("salary", "integer")])],
  ])("%s: minor, no reasons", (_name, next) => {
    const current = editor(next);
    current.readable.delete("salary");
    current.writable.delete("salary");
    expect(classifyItemsSchemaChange(ARTICLE_SCHEMA, current)).toEqual({ change: "minor", reasons: [] });
  });

  it("a readable field that is deleted is left to the SDK (the server cannot know old access)", () => {
    expect(classify(withFields(ARTICLE_SCHEMA.fields.filter((f) => f.key !== "rating")))).toEqual({ change: "minor", reasons: [] });
  });
});

describe("schemaChangeHeaders", () => {
  const current = () => editor(mapField("rating", (f) => ({ ...f, type: "text", validation: undefined })));
  const readableNow = "title,slug,body,rating,published_on,featured,tags,status_note,author,related,meta";
  let n = 0;
  const scope = () => `ws-${++n}:article`;

  it("adds nothing when no hash is sent or the hash is current", async () => {
    const loadPrevious = vi.fn();
    expect(await schemaChangeHeaders({ scope: scope(), requestHash: null, current: current(), loadPrevious })).toEqual({});
    expect(await schemaChangeHeaders({ scope: scope(), requestHash: NEW, current: current(), loadPrevious })).toEqual({});
    expect(await schemaChangeHeaders({ scope: scope(), requestHash: NEW.toUpperCase(), current: current(), loadPrevious })).toEqual({});
    expect(loadPrevious).not.toHaveBeenCalled();
  });

  it("classifies against the stored version and lists only readable fields", async () => {
    const headers = await schemaChangeHeaders({ scope: scope(), requestHash: OLD, current: current(), loadPrevious: async () => ARTICLE_SCHEMA });
    expect(headers).toEqual({ [SCHEMA_CHANGE_HEADER]: "major", [SCHEMA_FIELDS_HEADER]: readableNow });
    expect(headers[SCHEMA_FIELDS_HEADER]).not.toContain("secret");
  });

  it("a malformed hash is unknown without any lookup", async () => {
    const loadPrevious = vi.fn();
    for (const bad of ["abc", "z".repeat(64), `${OLD}x`, "' or 1=1 --"]) {
      expect((await schemaChangeHeaders({ scope: scope(), requestHash: bad, current: current(), loadPrevious }))[SCHEMA_CHANGE_HEADER]).toBe("unknown");
    }
    expect(loadPrevious).not.toHaveBeenCalled();
  });

  it("a hash that is not this model's version is unknown, the same as a malformed one", async () => {
    const malformed = await schemaChangeHeaders({ scope: scope(), requestHash: "nope", current: current(), loadPrevious: async () => null });
    const foreign = await schemaChangeHeaders({ scope: scope(), requestHash: "e".repeat(64), current: current(), loadPrevious: async () => null });
    expect(foreign).toEqual(malformed);
  });

  it("memoises per scope, hashes and access; different access never shares a result", async () => {
    const s = scope();
    const loadPrevious = vi.fn(async () => ARTICLE_SCHEMA);
    await schemaChangeHeaders({ scope: s, requestHash: OLD, current: current(), loadPrevious });
    await schemaChangeHeaders({ scope: s, requestHash: OLD, current: current(), loadPrevious });
    expect(loadPrevious).toHaveBeenCalledTimes(1);

    // Another caller who cannot read `rating`: separate entry, and the type change is invisible to it.
    const other = current();
    other.readable.delete("rating");
    other.writable.delete("rating");
    const headers = await schemaChangeHeaders({ scope: s, requestHash: OLD, current: other, loadPrevious });
    expect(loadPrevious).toHaveBeenCalledTimes(2);
    expect(headers[SCHEMA_CHANGE_HEADER]).toBe("minor");
    expect(headers[SCHEMA_FIELDS_HEADER]).not.toContain("rating");

    // Another workspace with the same model and hashes: separate entry.
    await schemaChangeHeaders({ scope: scope(), requestHash: OLD, current: current(), loadPrevious });
    expect(loadPrevious).toHaveBeenCalledTimes(3);
  });

  it("random hashes cannot grow memory past the cap", async () => {
    const s = scope();
    for (let i = 0; i < 700; i++) {
      await schemaChangeHeaders({ scope: s, requestHash: i.toString(16).padStart(64, "0"), current: current(), loadPrevious: async () => null });
    }
    expect(schemaChangeMemoSize()).toBeLessThanOrEqual(500);
  });

  it("a failed lookup is unknown and not cached", async () => {
    const s = scope();
    const loadPrevious = vi.fn(async () => { throw new Error("db down"); });
    expect((await schemaChangeHeaders({ scope: s, requestHash: OLD, current: current(), loadPrevious }))[SCHEMA_CHANGE_HEADER]).toBe("unknown");
    await schemaChangeHeaders({ scope: s, requestHash: OLD, current: current(), loadPrevious });
    expect(loadPrevious).toHaveBeenCalledTimes(2);
  });
});
