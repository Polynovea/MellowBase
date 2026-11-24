import { describe, expect, it } from "vitest";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
import { buildItemsOpenApi, type OpenApiModelInput } from "@/lib/developer/items/openapi";
import { ARTICLE_SCHEMA, FIXTURE_HASHES } from "@/lib/developer/items/testing/fixtureModels";
import { emitItemsTypes } from "@/lib/developer/sdkTypes/emit";
import { PRIVATE_HEADERS } from "@/lib/developer/items/http";
import { createTypesHandler } from "@/lib/developer/sdkTypes/typesRoute";

const WORKSPACE_HASH = "f".repeat(64);
const ctx: DeveloperApiContext = {
  requestId: "req-1", workspaceId: "ws", tokenId: "t", tokenName: "site", actorAdminUserId: null, scopes: ["schema.read"],
  allowedModels: [], rateLimit: { limit: 60, remaining: 59, resetAt: "2026-11-24T00:00:00Z" }, agentIdentityId: null, agentToolName: null, roleId: null,
};
function models(): OpenApiModelInput[] {
  const readable = new Set(ARTICLE_SCHEMA.fields.map((f) => f.key).filter((k) => k !== "secret"));
  return [{ apiKey: "article", name: "Article", schema: ARTICLE_SCHEMA, schemaHash: FIXTURE_HASHES.article, readable, writable: readable, canWrite: true, canDelete: true }];
}
const req = () => new Request("http://localhost/api/v1/types.ts", { headers: { authorization: "Bearer pnv_x" } });

describe("GET /api/v1/types.ts", () => {
  it("serves the caller's types file as private, unsniffable text", async () => {
    const GET = createTypesHandler({ auth: async () => ({ data: ctx }), load: async () => ({ models: models(), schemaHash: WORKSPACE_HASH }), now: () => new Date(Date.UTC(2026, 10, 24, 9, 30)) });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe(PRIVATE_HEADERS.vary);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-polynovea-schema-hash")).toBe(WORKSPACE_HASH);
    const body = await res.text();
    expect(body).toBe(emitItemsTypes(buildItemsOpenApi(models()), { schemaHash: WORKSPACE_HASH, generatedAt: "2026-11-24T09:30:00.000Z" }));
    expect(body.split("\n").slice(0, 2)).toEqual([`// schema-hash: ${WORKSPACE_HASH}`, "// generated-at: 2026-11-24T09:30:00.000Z"]);
    expect(body).not.toContain("secret");
  });

  it("passes an auth failure through untouched and never loads", async () => {
    let loaded = false;
    const denied = new Response("{}", { status: 403 });
    const GET = createTypesHandler({ auth: async () => ({ error: denied }), load: async () => { loaded = true; return { models: [], schemaHash: WORKSPACE_HASH }; } });
    expect(await GET(req())).toBe(denied);
    expect(loaded).toBe(false);
  });

  it("a loader failure is a plain 500 with no internals", async () => {
    const GET = createTypesHandler({ auth: async () => ({ data: ctx }), load: async () => { throw new Error("relation \"content_models\" does not exist"); } });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).toContain("TYPES_BUILD_FAILED");
    expect(body).not.toContain("content_models");
  });
});
