import { describe, expect, it } from "vitest";
import { lookupFor } from "@/lib/developer/items/access";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { checkJoins, parseExpand, parseFields, parseFilter, parseSort } from "@/lib/developer/items/filter";
import { HARD_LIMITS, type ApiLimits } from "@/lib/developer/items/types";
import { accessesFor, tokenPrincipal } from "@/lib/developer/items/testing/principals";

const lookup = lookupFor(accessesFor(tokenPrincipal()));
const L: ApiLimits = { ...HARD_LIMITS };
const F = (value: unknown, limits: ApiLimits = L) => parseFilter(typeof value === "string" ? value : JSON.stringify(value), "article", lookup, limits);
const fail = (fn: () => unknown) => {
  try { fn(); } catch (error) { if (error instanceof ItemsApiError) return { code: error.code, status: error.status, message: error.message, details: error.details }; throw error; }
  throw new Error("expected a refusal");
};
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("filter grammar", () => {
  it("parses groups, conditions and one relation hop", () => {
    const { filter, joins, conditions, depth } = F({ and: [{ title: { contains: "launch" } }, { or: [{ rating: { gt: 3 } }, { author: { name: { eq: "Asha" } } }] }] });
    expect(conditions).toBe(3);
    expect(depth).toBe(3);
    expect([...joins]).toEqual(["author"]);
    expect(filter).toMatchObject({ kind: "and", items: [{ kind: "cond", op: "contains", value: "launch" }, { kind: "or" }] });
    const hop = (filter as unknown as { items: [unknown, { items: [unknown, { path: Array<{ key: string }>; model: string }] }] }).items[1].items[1];
    expect(hop.path.map((p) => p.key)).toEqual(["author", "name"]);
    expect(hop.model).toBe("person");
  });

  it("an empty parameter is no filter", () => {
    expect(F("").filter).toBeNull();
    expect(parseFilter(null, "article", lookup, L).filter).toBeNull();
  });

  it("unknown and unreadable fields give the identical refusal, at any position", () => {
    const hidden = fail(() => F({ secret: { eq: "x" } }));
    const missing = fail(() => F({ secrex: { eq: "x" } }));
    expect(hidden.code).toBe("UNKNOWN_FIELD");
    expect({ ...hidden, message: "", details: { ...(hidden.details as object), field: "" } }).toEqual({ ...missing, message: "", details: { ...(missing.details as object), field: "" } });
    expect(fail(() => F({ author: { salary: { gt: 1 } } })).code).toBe("UNKNOWN_FIELD");
    expect(fail(() => F({ and: [{ title: { eq: "a" } }, { not: { secret: { null: true } } }] })).code).toBe("UNKNOWN_FIELD");
    expect(fail(() => F('{"__proto__":{"eq":"x"}}')).code).toBe("UNKNOWN_FIELD");
    expect(fail(() => F({ 'title" ; drop table x; --': { eq: "x" } })).code).toBe("UNKNOWN_FIELD");
  });

  it("checks operators against the field type", () => {
    expect(fail(() => F({ title: { gt: "a" } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ featured: { contains: "a" } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ title: { like: "a" } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ related: { null: true } })).code).toBe("FIELD_NOT_FILTERABLE");
    expect(F({ meta: { null: false } }).conditions).toBe(1);
    expect(fail(() => F({ meta: { eq: "x" } })).code).toBe("INVALID_FILTER");
    expect(F({ tags: { contains: "news" } }).conditions).toBe(1);
  });

  it("checks values against the field type; values are kept as data", () => {
    expect(fail(() => F({ rating: { eq: "3" } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ rating: { eq: 2.5 } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ published_on: { lt: "2026-02-30" } })).code).toBe("INVALID_FILTER");
    expect(F({ published_on: { lt: "2026-02-28" } }).conditions).toBe(1);
    expect(fail(() => F({ createdAt: { gt: "2026-01-01T00:00:00" } })).code).toBe("INVALID_FILTER");
    expect(F({ createdAt: { gt: "2026-01-01T00:00:00Z" } }).conditions).toBe(1);
    expect(fail(() => F({ author: { eq: "not-a-uuid" } })).code).toBe("INVALID_FILTER");
    expect(F({ author: { in: [UUID] } }).conditions).toBe(1);
    expect(fail(() => F({ featured: { eq: "true" } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ title: { null: "yes" } })).code).toBe("INVALID_FILTER");
    const odd = "50% off_ 'quoted' \\ back";
    expect((F({ title: { contains: odd } }).filter as unknown as { value: string }).value).toBe(odd);
  });

  it("rejects malformed shapes with a pointer", () => {
    expect(fail(() => F("{")).code).toBe("INVALID_FILTER");
    expect(fail(() => F([])).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ title: { eq: "a" }, rating: { eq: 1 } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ title: { eq: "a", neq: "b" } })).details).toEqual({ pointer: "/title" });
    expect(fail(() => F({ and: [] })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ author: { name: { and: [] } } })).code).toBe("INVALID_FILTER");
  });

  it("follows one relation only", () => {
    expect(fail(() => F({ author: { name: { eq: "x" } }, x: 1 })).code).toBe("INVALID_FILTER");
  });
});

describe("filter limits, each on its own", () => {
  it("depth: groups plus relation hops, up to 3", () => {
    expect(F({ and: [{ or: [{ not: { title: { eq: "a" } } }] }] }).depth).toBe(3);
    expect(fail(() => F({ and: [{ or: [{ not: { not: { title: { eq: "a" } } } }] }] })).code).toBe("FILTER_TOO_DEEP");
    expect(fail(() => F({ and: [{ or: [{ not: { author: { name: { eq: "a" } } } }] }] })).code).toBe("FILTER_TOO_DEEP");
  });

  it("conditions, group size, in size and bytes", () => {
    const many = { or: Array.from({ length: 21 }, (_, i) => ({ rating: { eq: i } })) };
    expect(fail(() => F(many)).code).toBe("FILTER_TOO_COMPLEX");
    expect(fail(() => F({ and: [many] }, { ...L, groupItems: 100 })).code).toBe("FILTER_TOO_COMPLEX");
    expect(fail(() => F({ rating: { in: Array.from({ length: 101 }, (_, i) => i) } })).code).toBe("INVALID_FILTER");
    expect(fail(() => F({ title: { eq: "x".repeat(9000) } })).code).toBe("FILTER_TOO_COMPLEX");
  });

  it("role overrides lower them", () => {
    expect(fail(() => F({ and: [{ title: { eq: "a" } }] }, { ...L, filterDepth: 0 })).code).toBe("FILTER_TOO_DEEP");
    expect(fail(() => F({ and: [{ title: { eq: "a" } }, { title: { eq: "b" } }] }, { ...L, filterConditions: 1 })).code).toBe("FILTER_TOO_COMPLEX");
  });
});

describe("sort, expand, fields", () => {
  it("sort: readable sortable keys of the model, at most 3, no repeats", () => {
    expect(parseSort("-publishedAt,title", "article", lookup, L).map((s) => [s.field, s.direction])).toEqual([["publishedAt", "desc"], ["title", "asc"]]);
    expect(fail(() => parseSort("secret", "article", lookup, L))).toMatchObject({ code: "UNKNOWN_FIELD" });
    expect(fail(() => parseSort("-secret", "article", lookup, L))).toMatchObject({ code: "UNKNOWN_FIELD" });
    expect(fail(() => parseSort("body", "article", lookup, L)).code).toBe("INVALID_SORT");
    expect(fail(() => parseSort("tags", "article", lookup, L)).code).toBe("INVALID_SORT");
    expect(fail(() => parseSort("a,b,c,d", "article", lookup, L)).code).toBe("INVALID_SORT");
    expect(fail(() => parseSort("title,-title", "article", lookup, L)).code).toBe("INVALID_SORT");
    expect(fail(() => parseSort("title,", "article", lookup, L)).code).toBe("INVALID_SORT");
  });

  it("expand: relation fields the caller can read, depth up to 2", () => {
    const { tree, joins, depth } = parseExpand("author,related,related.author", "article", lookup, L);
    expect(depth).toBe(2);
    expect([...joins].sort()).toEqual(["author", "related", "related.author"]);
    expect(tree.map((n) => n.field.key)).toEqual(["author", "related"]);
    expect(tree[1].children.map((n) => n.target)).toEqual(["person"]);
    expect(fail(() => parseExpand("related.related.author", "article", lookup, L)).code).toBe("EXPAND_TOO_DEEP");
    expect(fail(() => parseExpand("secret", "article", lookup, L)).code).toBe("UNKNOWN_FIELD");
    expect(fail(() => parseExpand("title", "article", lookup, L)).code).toBe("INVALID_EXPAND");
    expect(fail(() => parseExpand("author..x", "article", lookup, L)).code).toBe("INVALID_EXPAND");
    expect(fail(() => parseExpand("author.salary", "article", lookup, L)).code).toBe("UNKNOWN_FIELD");
  });

  it("joins: at most 5 distinct relation paths across filter and expand", () => {
    expect(() => checkJoins(L, new Set(["author"]), new Set(["author", "related"]))).not.toThrow();
    expect(fail(() => checkJoins({ ...L, joins: 1 }, new Set(["author"]), new Set(["related"]))).code).toBe("TOO_MANY_JOINS");
    expect(fail(() => checkJoins(L, new Set(["a", "b", "c"]), new Set(["d", "e", "f"]))).code).toBe("TOO_MANY_JOINS");
  });

  it("fields: readable data fields only", () => {
    expect([...parseFields("title,author", "article", lookup)!]).toEqual(["title", "author"]);
    expect(parseFields(null, "article", lookup)).toBeNull();
    expect(fail(() => parseFields("title,secret", "article", lookup)).code).toBe("UNKNOWN_FIELD");
    expect(fail(() => parseFields("id", "article", lookup)).code).toBe("UNKNOWN_FIELD");
  });
});
