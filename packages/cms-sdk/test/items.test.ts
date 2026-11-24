import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolynoveaItemsError, PolynoveaSchemaDriftError, createCmsClient, resetSchemaDriftWarnings, type PolynoveaCmsOptions } from "../src/index.js";
import { schema, type Models } from "./fixture/polynovea-cms.js";

const ARTICLE_HASH = schema.models.article.hash;
const NEW_HASH = "d".repeat(64);
const readableNow = schema.models.article.fields.join(",");

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Call = { url: URL; init: RequestInit & { headers: Headers } };

const item = (id: string) => ({ id, locale: "en", variant: "published", version: 1, createdAt: "t", updatedAt: "t", publishedAt: "t", data: { title: id } });
const listBody = (ids: string[], nextCursor: string | null = null) => ({ data: ids.map(item), meta: { requestId: "r", timestamp: "t", schemaHash: ARTICLE_HASH, page: { limit: 25, nextCursor } } });

function mockFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init as Call["init"] });
    const next = replies.shift() ?? { body: listBody([]) };
    const status = next.status ?? 200;
    const body = status === 204 || next.body === undefined ? null : JSON.stringify(next.body);
    return new Response(body, { status, headers: { "content-type": "application/json", "x-polynovea-schema-hash": ARTICLE_HASH, ...next.headers } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function client(replies: Reply[], extra: Partial<PolynoveaCmsOptions> = {}) {
  const mock = mockFetch(replies);
  const warn = vi.fn();
  const cms = createCmsClient<Models>({ baseUrl: "https://cms.example.test/", token: "pnv_secret", schema, fetch: mock.fetch, logger: { warn }, ...extra });
  return { cms, warn, ...mock };
}

beforeEach(() => resetSchemaDriftWarnings());

describe("items client: requests", () => {
  it("encodes filter, sort, expand, fields, limit, cursor, locale and variant", async () => {
    const { cms, calls } = client([{ body: listBody(["a"]) }]);
    const filter = { and: [{ title: { contains: "50% off_\\" } }, { rating: { gt: 3 } }] };
    const page = await cms.items("article").list({ filter, sort: ["-published_on", "title"], expand: ["author", "related.author"], fields: ["title"], limit: 10, cursor: "abc", locale: "en", variant: "draft" });
    expect(page.data[0].data.title).toBe("a");
    const { url, init } = calls[0];
    expect(url.origin + url.pathname).toBe("https://cms.example.test/api/v1/models/article/items");
    expect(JSON.parse(url.searchParams.get("filter")!)).toEqual(filter);
    expect(url.searchParams.get("sort")).toBe("-published_on,title");
    expect(url.searchParams.get("expand")).toBe("author,related.author");
    expect(url.searchParams.get("fields")).toBe("title");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(url.searchParams.get("locale")).toBe("en");
    expect(url.searchParams.get("variant")).toBe("draft");
    expect(init.method).toBe("GET");
    expect(init.headers.get("authorization")).toBe("Bearer pnv_secret");
    expect(init.headers.get("x-polynovea-schema-hash")).toBe(ARTICLE_HASH);
  });

  it("sends the preview token from the config, and a call can override it", async () => {
    const { cms, calls } = client([{ body: { data: item("a"), meta: {} } }, { body: { data: item("a"), meta: {} } }], { preview: "from-config" });
    await cms.items("article").get("a b");
    await cms.items("article").get("a", { preview: "per-call" });
    expect(calls[0].url.pathname).toBe("/api/v1/models/article/items/a%20b");
    expect(calls[0].init.headers.get("x-polynovea-preview")).toBe("from-config");
    expect(calls[1].init.headers.get("x-polynovea-preview")).toBe("per-call");
  });

  it("writes JSON bodies for create and update, and delete takes a 204", async () => {
    const { cms, calls } = client([{ status: 201, body: { data: item("n"), meta: {} } }, { body: { data: item("n"), meta: {} } }, { status: 204 }]);
    await cms.items("article").create({ title: "New" });
    await cms.items("article").update("n", { featured: true });
    await expect(cms.items("article").delete("n")).resolves.toBeUndefined();
    expect(calls.map((c) => c.init.method)).toEqual(["POST", "PATCH", "DELETE"]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "New" });
    expect(calls[0].init.headers.get("content-type")).toBe("application/json");
    expect(calls[1].url.pathname).toBe("/api/v1/models/article/items/n");
  });

  it("all() follows nextCursor until it is null", async () => {
    const { cms, calls } = client([{ body: listBody(["a", "b"], "c1") }, { body: listBody(["c"], "c2") }, { body: listBody([], null) }]);
    const ids: string[] = [];
    for await (const one of cms.items("article").all({ sort: "title" })) ids.push(one.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls.map((c) => c.url.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
    expect(calls[0].url.searchParams.get("limit")).toBe("100");
  });

  it("works without generated types", async () => {
    const mock = mockFetch([{ body: listBody(["a"]) }]);
    const loose = createCmsClient({ baseUrl: "http://localhost:3000", token: "pnv_x", fetch: mock.fetch });
    const page = await loose.items("whatever").list({ filter: { anything: { eq: 1 } } });
    expect(page.data).toHaveLength(1);
    expect(mock.calls[0].init.headers.get("x-polynovea-schema-hash")).toBeNull();
  });
});

describe("items client: errors", () => {
  it("maps the error envelope, code and Retry-After", async () => {
    const { cms } = client([{ status: 503, body: { error: { code: "MODEL_TABLE_NOT_READY", message: "Not ready" }, meta: { requestId: "req-9" } }, headers: { "retry-after": "30" } }]);
    const error = await cms.items("article").list({ filter: { rating: { gt: 1 } } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolynoveaItemsError);
    expect(error).toMatchObject({ status: 503, code: "MODEL_TABLE_NOT_READY", message: "Not ready", requestId: "req-9", retryAfter: 30 });
  });

  it("a non-JSON error and a network failure still give typed errors, never the token", async () => {
    const { cms } = client([{ status: 502 }]);
    expect(await cms.items("article").get("x").catch((e: unknown) => e)).toMatchObject({ status: 502, code: "HTTP_ERROR" });
    const failing = createCmsClient<Models>({ baseUrl: "https://cms.example.test", token: "pnv_secret", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    const network = (await failing.items("article").list().catch((e: unknown) => e)) as PolynoveaItemsError;
    expect(network).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    expect(network.message).not.toContain("pnv_secret");
  });
});

describe("items client: schema drift", () => {
  const drifted = (change: string | null, fields = readableNow): Reply => ({
    body: listBody(["a"]),
    headers: { "x-polynovea-schema-hash": NEW_HASH, ...(change ? { "x-polynovea-schema-change": change } : {}), "x-polynovea-schema-fields": fields },
  });

  it("is silent when the hash matches or the change is additive", async () => {
    const onSchemaChange = vi.fn();
    const { cms, warn } = client([{ body: listBody(["a"]) }, drifted("minor"), drifted("minor")], { onSchemaChange });
    for (let i = 0; i < 3; i++) await cms.items("article").list();
    expect(warn).not.toHaveBeenCalled();
    expect(onSchemaChange).toHaveBeenCalledTimes(1);
    expect(onSchemaChange.mock.calls[0][0]).toMatchObject({ model: "article", change: "minor", removedFields: [] });
  });

  it("warns once per process on a breaking change", async () => {
    const { cms, warn } = client([drifted("major"), drifted("major")]);
    await cms.items("article").list();
    await cms.items("article").list();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("article changed in a breaking way");
    const second = client([drifted("major")]);
    await second.cms.items("article").list();
    expect(second.warn).not.toHaveBeenCalled();
  });

  it("a field the types know that is no longer readable is breaking, even when the server says minor", async () => {
    const { cms, warn } = client([drifted("minor", readableNow.replace("rating,", ""))]);
    await cms.items("article").list();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("no longer readable: rating");
  });

  it("unknown, or an older server with no signal, warns once with a softer message", async () => {
    const { cms, warn } = client([drifted("unknown")]);
    await cms.items("article").list();
    expect(warn.mock.calls[0][0]).toContain("cannot say whether it is breaking");
    resetSchemaDriftWarnings();
    const old = client([{ body: listBody(["a"]), headers: { "x-polynovea-schema-hash": NEW_HASH } }]);
    await old.cms.items("article").list();
    expect(old.warn).toHaveBeenCalledTimes(1);
  });

  it("never throws by default; strict mode throws on major only", async () => {
    const lax = client([drifted("major")]);
    await expect(lax.cms.items("article").list()).resolves.toBeDefined();
    const strict = client([drifted("major"), drifted("minor"), drifted("unknown")], { strictSchema: true });
    await expect(strict.cms.items("article").list()).rejects.toBeInstanceOf(PolynoveaSchemaDriftError);
    await expect(strict.cms.items("article").list()).resolves.toBeDefined();
    await expect(strict.cms.items("article").list()).resolves.toBeDefined();
  });

  it("strict mode keeps the API error when the response is an error", async () => {
    const { cms } = client([{ status: 400, body: { error: { code: "UNKNOWN_FIELD", message: "Unknown field" }, meta: {} }, headers: { "x-polynovea-schema-hash": NEW_HASH, "x-polynovea-schema-change": "major", "x-polynovea-schema-fields": readableNow } }], { strictSchema: true });
    await expect(cms.items("article").list()).rejects.toMatchObject({ code: "UNKNOWN_FIELD" });
  });
});
