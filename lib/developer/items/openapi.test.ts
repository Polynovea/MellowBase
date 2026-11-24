import { describe, expect, it } from "vitest";
import { buildItemsOpenApi, componentName, type OpenApiModelInput } from "@/lib/developer/items/openapi";
import { ARTICLE_SCHEMA, FIXTURE_HASHES, PERSON_SCHEMA } from "@/lib/developer/items/testing/fixtureModels";

const all = (schema: typeof ARTICLE_SCHEMA) => new Set(schema.fields.map((field) => field.key));

/** An editor who cannot read `secret` (article) or `salary` (person), and cannot write `rating`. */
function editorModels(): OpenApiModelInput[] {
  const articleRead = all(ARTICLE_SCHEMA);
  articleRead.delete("secret");
  const articleWrite = new Set(articleRead);
  articleWrite.delete("rating");
  const personRead = all(PERSON_SCHEMA);
  personRead.delete("salary");
  return [
    { apiKey: "article", name: "Article", schema: ARTICLE_SCHEMA, schemaHash: FIXTURE_HASHES.article, readable: articleRead, writable: articleWrite, canWrite: true, canDelete: true },
    { apiKey: "person", name: "Person", schema: PERSON_SCHEMA, schemaHash: FIXTURE_HASHES.person, readable: personRead, writable: new Set(), canWrite: false, canDelete: false },
  ];
}

describe("items OpenAPI", () => {
  it("matches the fixture snapshot wave 2 builds against", async () => {
    await expect(JSON.stringify(buildItemsOpenApi(editorModels()), null, 2)).toMatchFileSnapshot("./__snapshots__/openapi.fixture.json");
  });

  it("never names a field the caller cannot read, anywhere in the document", () => {
    const doc = JSON.stringify(buildItemsOpenApi(editorModels()));
    expect(doc).not.toContain("secret");
    expect(doc).not.toContain("salary");
  });

  it("writes list only writable fields; a read-only model gets no write operations", () => {
    const { schemas, paths } = buildItemsOpenApi(editorModels());
    const create = schemas.ArticleCreate as { properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
    expect(Object.keys(create.properties)).not.toContain("rating");
    expect(create.properties).toHaveProperty("title");
    expect(create.required).toEqual(["title"]);
    expect(create.additionalProperties).toBe(false);
    expect(Object.keys(paths["/api/v1/models/person/items"]!)).toEqual(["get"]);
    expect(Object.keys(paths["/api/v1/models/person/items/{id}"]!)).toEqual(["get"]);
    expect(Object.keys(paths["/api/v1/models/article/items/{id}"]!).sort()).toEqual(["delete", "get", "patch"]);
  });

  it("filters and sorts only on readable, column-backed fields; to-many relations are not filterable", () => {
    const { schemas } = buildItemsOpenApi(editorModels());
    const cond = (schemas.ArticleFieldCondition as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(cond)).toEqual(expect.arrayContaining(["id", "createdAt", "title", "rating", "author", "tags"]));
    expect(Object.keys(cond)).not.toContain("related");
    expect(Object.keys(cond)).not.toContain("secret");
    const sort = (schemas.ArticleSortKey as { enum: string[] }).enum;
    expect(sort).toContain("-rating");
    expect(sort).not.toContain("tags");
    expect(sort).not.toContain("body");
  });

  it("a relation into a model missing from the document is a bare id", () => {
    const [article] = editorModels();
    const { schemas } = buildItemsOpenApi([article]);
    const author = (schemas.ArticleData as { properties: Record<string, Record<string, unknown>> }).properties.author;
    expect(author.oneOf).toBeUndefined();
    expect(author).toMatchObject({ type: "string", format: "uuid" });
  });

  it("makes model api keys identifier-safe", () => {
    expect(componentName("blog-post")).toBe("Blog_post");
    expect(componentName("article")).toBe("Article");
  });
});

describe("workspace schema hash", async () => {
  const { workspaceSchemaHash } = await import("@/lib/developer/items/openapiHash");
  it("is order-independent and changes with any model's hash", () => {
    const a = workspaceSchemaHash([{ apiKey: "a", schemaHash: "1" }, { apiKey: "b", schemaHash: "2" }]);
    expect(workspaceSchemaHash([{ apiKey: "b", schemaHash: "2" }, { apiKey: "a", schemaHash: "1" }])).toBe(a);
    expect(workspaceSchemaHash([{ apiKey: "a", schemaHash: "1" }, { apiKey: "b", schemaHash: "3" }])).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
