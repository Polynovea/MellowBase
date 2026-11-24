import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { requestId: "req-1", workspaceId: "ws", tokenId: "tok", tokenName: "t", actorAdminUserId: null, scopes: ["schema.read"], allowedModels: [], rateLimit: { limit: 10, remaining: 9, resetAt: "2026-11-24T00:00:00Z" }, agentIdentityId: null, agentToolName: null, roleId: null };

vi.mock("@/lib/developer/apiAuth", () => ({ requireDeveloperApi: vi.fn(async () => ({ data: auth })) }));
vi.mock("@/lib/db/index", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/developer/items/principal", () => ({ principalForToken: vi.fn(async () => ({})), previewScope: vi.fn(async () => null) }));
vi.mock("@/lib/developer/items/openapiInputs", () => ({ loadItemsOpenApiInputs: vi.fn(async () => ({ models: [], schemaHash: "h" })) }));
vi.mock("@/lib/developer/openapiService", () => ({ buildWorkspaceOpenApi: vi.fn(async () => ({ openapi: "3.1.0" })) }));

import { GET as openapi } from "@/app/api/v1/openapi.json/route";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { itemsError, itemsOk } from "@/lib/developer/items/http";

const privateCache = (response: Response) => {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toContain("Authorization");
};

describe("per-caller responses are never shared by a cache", () => {
  beforeEach(() => vi.mocked(requireDeveloperApi).mockClear());

  it("openapi.json is private, no-store and varies by Authorization", async () => {
    const response = await openapi(new Request("https://cms.example.test/api/v1/openapi.json", { headers: { authorization: "Bearer pnv_x" } }));
    expect(response.status).toBe(200);
    privateCache(response);
    expect((await response.json()).data).toEqual({ openapi: "3.1.0" });
  });

  it("items success and error responses are private too; 503 table-not-ready carries Retry-After", async () => {
    privateCache(itemsOk({ data: [] }, { requestId: "r" }, "h".repeat(64)));
    const notReady = itemsError(new ItemsApiError("MODEL_TABLE_NOT_READY", "later"), { requestId: "r" });
    privateCache(notReady);
    expect(notReady.status).toBe(503);
    expect(notReady.headers.get("retry-after")).toBe("30");
  });

  it("unexpected failures answer a generic 503 without internals", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = itemsError(Object.assign(new Error("relation \"content.m_secret\" does not exist"), { code: "42P01" }), { requestId: "r" });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error).toEqual({ code: "ITEMS_UNAVAILABLE", message: "Items could not be read right now" });
    expect(JSON.stringify(body)).not.toContain("m_secret");
    spy.mockRestore();
  });

  it("the schema hash travels as a header and in meta", async () => {
    const response = itemsOk({ data: [], meta: { page: { limit: 25, nextCursor: null } } }, { requestId: "r" }, "a".repeat(64));
    expect(response.headers.get("x-polynovea-schema-hash")).toBe("a".repeat(64));
    expect((await response.json()).meta).toMatchObject({ schemaHash: "a".repeat(64), page: { limit: 25, nextCursor: null } });
  });
});

describe("bound-agent tokens: the items routes are governed tools", async () => {
  const { resolveAgentToolForApiRequest } = await import("@/lib/developer/agentRouteMapping");
  const tool = (method: string, pathname: string) => resolveAgentToolForApiRequest({ method, pathname });
  it("maps each items operation to the same tool as the entries routes", () => {
    expect(tool("GET", "/api/v1/models/article/items")).toBe("cms.content.search");
    expect(tool("GET", "/api/v1/models/article/items/3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe("cms.content.get");
    expect(tool("POST", "/api/v1/models/article/items")).toBe("cms.draft.create");
    expect(tool("PATCH", "/api/v1/models/article/items/x")).toBe("cms.draft.update");
    expect(tool("DELETE", "/api/v1/models/article/items/x")).toBe("cms.delete");
    expect(tool("PUT", "/api/v1/models/article/items/x")).toBeNull();
    expect(tool("GET", "/api/v1/models/article")).toBe("cms.schema.get");
  });
});
