import { describe, expect, it, vi } from "vitest";
import { ARTICLE_SCHEMA, FIXTURE_HASHES, PERSON_SCHEMA } from "@/lib/developer/items/testing/fixtureModels";

const schemas = { article: ARTICLE_SCHEMA, person: PERSON_SCHEMA, "blog-post": { ...PERSON_SCHEMA, name: "Blog post", apiKey: "blog-post" } } as const;
vi.mock("@/lib/schema/modelService", () => ({
  listModels: vi.fn(async () => Object.keys(schemas).map((apiKey) => ({ id: `id-${apiKey}`, api_key: apiKey, name: apiKey, status: "active", current_schema_version: 1 }))),
  getVersion: vi.fn(async (id: string) => ({ schema_json: schemas[id.slice(3) as keyof typeof schemas] })),
}));

import { buildWorkspaceOpenApi } from "@/lib/developer/openapiService";

/** What most client generators do to an operationId (openapi-generator, orval, NSwag camelCase it). */
const normalise = (id: string) => id.toLowerCase().replace(/[_-]/g, "");

function operationIds(document: { paths: Record<string, Record<string, unknown>> }): string[] {
  return Object.values(document.paths).flatMap((methods) => Object.values(methods)
    .map((operation) => (operation as { operationId?: string }).operationId)
    .filter((id): id is string => typeof id === "string"));
}

describe("operationIds never clash, even after a generator camelCases them", () => {
  const all = (keys: string[]) => keys.map((apiKey) => {
    const schema = schemas[apiKey as keyof typeof schemas];
    const keysSet = new Set(schema.fields.map((field) => field.key));
    return { apiKey, name: apiKey, schema, schemaHash: FIXTURE_HASHES.article, readable: keysSet, writable: keysSet, canWrite: true, canDelete: true };
  });

  it("per-token document (legacy content paths + items paths)", async () => {
    const document = await buildWorkspaceOpenApi("ws", "https://cms.example.test", { items: all(Object.keys(schemas)) });
    const ids = operationIds(document as never);
    expect(ids).toContain("list_article"); // legacy id kept
    expect(ids).toContain("items_list_Article");
    const normalised = ids.map(normalise);
    expect(new Set(normalised).size).toBe(normalised.length);
  });

  it("admin document (no items paths)", async () => {
    const ids = operationIds(await buildWorkspaceOpenApi("ws", "https://cms.example.test") as never);
    const normalised = ids.map(normalise);
    expect(new Set(normalised).size).toBe(normalised.length);
  });
});
