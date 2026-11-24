import { describe, expect, it } from "vitest";
import { buildItemsOpenApi, type ItemsOpenApi } from "@/lib/developer/items/openapi";
import { ARTICLE_SCHEMA, FIXTURE_HASHES } from "@/lib/developer/items/testing/fixtureModels";
import snapshot from "@/lib/developer/items/__snapshots__/openapi.fixture.json";
import { emitItemsTypes, modelsOf } from "@/lib/developer/sdkTypes/emit";

/** The workspace hash the committed fixture types file carries. */
export const FIXTURE_WORKSPACE_HASH = "c".repeat(64);
const doc = snapshot as unknown as ItemsOpenApi;

describe("types file emitter", () => {
  it("emits W1's fixture snapshot into the committed SDK fixture (run vitest -u to refresh)", async () => {
    await expect(emitItemsTypes(doc, { schemaHash: FIXTURE_WORKSPACE_HASH })).toMatchFileSnapshot("../../../packages/cms-sdk/test/fixture/polynovea-cms.ts");
  });

  it("is deterministic", () => {
    expect(emitItemsTypes(doc, { schemaHash: FIXTURE_WORKSPACE_HASH })).toBe(emitItemsTypes(doc, { schemaHash: FIXTURE_WORKSPACE_HASH }));
  });

  it("never names a field the caller cannot read", () => {
    const out = emitItemsTypes(doc, { schemaHash: FIXTURE_WORKSPACE_HASH });
    expect(out).not.toContain("secret");
    expect(out).not.toContain("salary");
  });

  it("lists models with what the caller may do", () => {
    expect(modelsOf(doc).map(({ apiKey, writable, updatable, deletable, hash }) => ({ apiKey, writable, updatable, deletable, hash }))).toEqual([
      { apiKey: "article", writable: true, updatable: true, deletable: true, hash: FIXTURE_HASHES.article },
      { apiKey: "person", writable: false, updatable: false, deletable: false, hash: FIXTURE_HASHES.person },
    ]);
  });

  it("a read-only model gets no Create or Patch type", () => {
    const out = emitItemsTypes(doc, { schemaHash: FIXTURE_WORKSPACE_HASH });
    expect(out).toContain("export interface ArticleCreate");
    expect(out).not.toContain("PersonCreate");
    expect(out).toMatch(/person: \{\n    data: PersonData;\n    item: PersonItem;\n    create: never;\n    patch: never;/);
  });

  it("escapes labels so nothing can close the comment or inject code", () => {
    const schema = { ...ARTICLE_SCHEMA, fields: [{ ...ARTICLE_SCHEMA.fields[0], label: "Title */ export const x = 1; /*\nnext" }] };
    const all = new Set(["title"]);
    const out = emitItemsTypes(buildItemsOpenApi([{ apiKey: "article", name: "Article */ x", schema, schemaHash: "a".repeat(64), readable: all, writable: all, canWrite: true, canDelete: true }]), { schemaHash: FIXTURE_WORKSPACE_HASH });
    expect(out).not.toContain("*/ export const x");
    expect(out).toContain(String.raw`/** Title *\/ export const x = 1; /* next (text) */`);
  });

  it("quotes keys that are not identifiers and refuses a malformed hash", () => {
    const schema = { name: "Blog post", apiKey: "blog-post", fields: [{ ...ARTICLE_SCHEMA.fields[0], key: "title" }] };
    const all = new Set(["title"]);
    const built = buildItemsOpenApi([{ apiKey: "blog-post", name: "Blog post", schema, schemaHash: "a".repeat(64), readable: all, writable: all, canWrite: true, canDelete: true }]);
    const out = emitItemsTypes(built, { schemaHash: FIXTURE_WORKSPACE_HASH });
    expect(out).toContain(`"blog-post": {`);
    expect(out).toContain("export interface Blog_postData");
    expect(() => emitItemsTypes(built, { schemaHash: "not-a-hash" })).toThrow();
  });
});
