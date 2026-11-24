import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import type { TableSource } from "@/lib/content/tableStore";
import { lookupFor } from "@/lib/developer/items/access";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { parseFilter, parseSort } from "@/lib/developer/items/filter";
import { needsTable, runItemsQuery, type QueryModel } from "@/lib/developer/items/query";
import { HARD_LIMITS } from "@/lib/developer/items/types";
import { ARTICLE, PERSON, WS, accessesFor, tokenPrincipal } from "@/lib/developer/items/testing/principals";

function capturingDb() {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => { if (event.level === "query") queries.push(event.query); },
  });
  return { db, queries };
}

const column = (name: string, field: string, fieldType: string, pgType: string) => ({ name, field, fieldType, pgType, requiredWhenPublished: false, unique: false, indexed: false });
const ARTICLE_SOURCE: TableSource = {
  modelId: ARTICLE.id,
  table: "m_article",
  shape: { table: "m_article", columns: Object.fromEntries([
    column("title", "title", "text", "text"), column("rating", "rating", "integer", "bigint"), column("tags", "tags", "multi_select", "jsonb"),
    column("author", "author", "relation", "uuid"), column("secret", "secret", "text", "text"), column("featured", "featured", "boolean", "boolean"),
  ].map((c) => [c.name, c])) } as TableSource["shape"],
  snapshotKeys: ["related"],
  fieldKeys: new Set(ARTICLE.schema.fields.map((f) => f.key)),
};
const PERSON_SOURCE: TableSource = {
  modelId: PERSON.id, table: "m_person",
  shape: { table: "m_person", columns: { name: column("name", "name", "text", "text") } } as TableSource["shape"],
  snapshotKeys: [], fieldKeys: new Set(["name", "email", "salary"]),
};
const lookup = lookupFor(accessesFor(tokenPrincipal()));
const article: QueryModel = { id: ARTICLE.id, apiKey: "article", source: ARTICLE_SOURCE };
const relationModels = new Map<string, QueryModel>([["person", { id: PERSON.id, apiKey: "person", source: PERSON_SOURCE }], ["article", article]]);

describe("items SQL", () => {
  it("identifiers come from metadata, quoted; every value is a parameter", async () => {
    const { db, queries } = capturingDb();
    const evil = `x'); drop table content.m_article; --`;
    const filter = parseFilter(JSON.stringify({ and: [{ title: { contains: evil } }, { author: { name: { eq: evil } } }, { tags: { contains: "news" } }, { rating: { in: [1, 2] } }] }), "article", lookup, HARD_LIMITS).filter;
    await runItemsQuery(db, { workspaceId: WS, model: article, variant: "published", filter, relationModels, sort: parseSort("-rating", "article", lookup, HARD_LIMITS), search: null, limit: 26 });
    const [q] = queries;
    expect(q.sql).toContain(`from "content"."m_article" r`);
    expect(q.sql).toContain(`"content"."m_person"`);
    expect(q.sql).not.toContain("drop table");
    expect(q.parameters).toContain(evil);
    expect(q.parameters).toContain(`%x'); drop table content.m\\_article; --%`);
    expect(q.parameters).toContain(JSON.stringify(["news"]));
    expect(q.sql).toMatch(/limit \$\d+/);
    expect(q.sql).toContain(`"r"."rating" desc nulls last`);
  });

  it("search matches only the given (readable) text columns", async () => {
    const { db, queries } = capturingDb();
    await runItemsQuery(db, { workspaceId: WS, model: article, variant: "published", sort: [], search: { term: "launch", fields: [lookup.field("article", "title")!] }, limit: 5 });
    expect(queries[0].sql).toContain(`"r"."title" ilike`);
    expect(queries[0].sql).not.toContain(`"r"."secret"`);
    const empty = capturingDb();
    await runItemsQuery(empty.db, { workspaceId: WS, model: article, variant: "published", sort: [], search: { term: "launch", fields: [] }, limit: 5 });
    expect(empty.queries[0].sql).toMatch(/and false/);
  });

  it("drafts read the draft row, or the published one when there is no draft", async () => {
    const { db, queries } = capturingDb();
    await runItemsQuery(db, { workspaceId: WS, model: article, variant: "draft", entryIds: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"], sort: [], limit: 5 });
    expect(queries[0].sql).toContain(`= 'draft' or`);
    expect(queries[0].sql).toContain(`<> 'archived'`);
  });

  it("without a ready table, plain reads use snapshots and anything needing columns is MODEL_TABLE_NOT_READY", async () => {
    const snapshotModel: QueryModel = { ...article, source: null };
    const { db, queries } = capturingDb();
    await runItemsQuery(db, { workspaceId: WS, model: snapshotModel, variant: "published", sort: parseSort("-updatedAt", "article", lookup, HARD_LIMITS), limit: 5 });
    expect(queries[0].sql).toContain("public.content_entry_versions vv");
    expect(needsTable({ filter: null, search: null, sort: parseSort("-updatedAt,id", "article", lookup, HARD_LIMITS) })).toBe(false);
    for (const q of [
      { filter: parseFilter(JSON.stringify({ title: { eq: "a" } }), "article", lookup, HARD_LIMITS).filter, sort: [] },
      { sort: parseSort("title", "article", lookup, HARD_LIMITS) },
      { sort: [], search: { term: "ab", fields: [] } },
    ]) {
      await expect(runItemsQuery(db, { workspaceId: WS, model: snapshotModel, variant: "published", limit: 5, ...q })).rejects.toMatchObject({ code: "MODEL_TABLE_NOT_READY", status: 503 });
    }
  });

  it("a cursor continues strictly after the last row, nulls last", async () => {
    const { db, queries } = capturingDb();
    await runItemsQuery(db, {
      workspaceId: WS, model: article, variant: "published", sort: parseSort("-rating", "article", lookup, HARD_LIMITS), limit: 5,
      after: { v: 1, s: "x", k: [3], id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", l: "en" },
    });
    expect(queries[0].sql).toContain(`("r"."rating" is null or "r"."rating" < cast(`);
    expect(queries[0].parameters).toEqual(expect.arrayContaining([3, "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "en"]));
  });

  it("a hop into a related model without a ready table is MODEL_TABLE_NOT_READY", async () => {
    const { db } = capturingDb();
    const filter = parseFilter(JSON.stringify({ author: { name: { eq: "a" } } }), "article", lookup, HARD_LIMITS).filter;
    const noPersonTable = new Map<string, QueryModel>([["person", { id: PERSON.id, apiKey: "person", source: null }]]);
    const error = await runItemsQuery(db, { workspaceId: WS, model: article, variant: "published", filter, relationModels: noPersonTable, sort: [], limit: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(ItemsApiError);
    expect(error.code).toBe("MODEL_TABLE_NOT_READY");
  });

  it("no sql.raw anywhere in the items API", () => {
    const dir = join(process.cwd(), "lib", "developer", "items");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/sql\.raw|sql\.lit\b/);
    }
  });
});
