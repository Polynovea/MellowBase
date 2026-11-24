import { describe, expect, it } from "vitest";
import { lookupFor } from "@/lib/developer/items/access";
import { decodeCursor, encodeCursor, sortSpecHash } from "@/lib/developer/items/cursor";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { parseSort } from "@/lib/developer/items/filter";
import { HARD_LIMITS } from "@/lib/developer/items/types";
import { ROLE, accessesFor, tokenPrincipal } from "@/lib/developer/items/testing/principals";

const KEY = Buffer.alloc(32, 7);
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const viewer = lookupFor(accessesFor(tokenPrincipal({ roleIds: [ROLE.viewer], roleKeys: ["viewer"] })));
const editor = lookupFor(accessesFor(tokenPrincipal()));
const sortFor = (lookup: typeof viewer, raw: string) => parseSort(raw, "article", lookup, HARD_LIMITS);

function refusal(fn: () => unknown) {
  try { fn(); } catch (error) { return error instanceof ItemsApiError ? { code: error.code, status: error.status, message: error.message, details: error.details } : error; }
  return null;
}

describe("items cursors", () => {
  const sort = sortFor(viewer, "-rating,title");
  const spec = sortSpecHash("article", "published", sort);
  const cursor = encodeCursor({ s: spec, k: [4, "Hello"], id: ID }, "token-a", KEY);

  it("round-trips for the same caller and sort", () => {
    expect(decodeCursor(cursor, "token-a", { specHash: spec, sort }, KEY)).toEqual({ v: 1, s: spec, k: [4, "Hello"], id: ID });
  });

  it("another caller's cursor is a plain 400, never its values", () => {
    const r = refusal(() => decodeCursor(cursor, "token-b", { specHash: spec, sort }, KEY));
    expect(r).toMatchObject({ code: "INVALID_CURSOR", status: 400 });
    expect(JSON.stringify(r)).not.toContain("Hello");
  });

  it("a hand-edited cursor (payload or signature) is the same 400 and leaks nothing", () => {
    const [body, sig] = cursor.split(".");
    const edited = Buffer.from(JSON.stringify({ v: 1, s: spec, k: [5, "Hello"], id: ID })).toString("base64url");
    for (const bad of [`${edited}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, `${body}`, `${body}.${sig}.x`, "garbage", "a".repeat(3000)]) {
      const r = refusal(() => decodeCursor(bad, "token-a", { specHash: spec, sort }, KEY));
      expect(r).toMatchObject({ code: "INVALID_CURSOR", status: 400, message: "The cursor is not valid for this request. Start again without a cursor." });
      expect(JSON.stringify(r)).not.toContain("Hello");
    }
  });

  it("a cursor is tied to its sort spec", () => {
    const other = sortFor(viewer, "title");
    expect(refusal(() => decodeCursor(cursor, "token-a", { specHash: sortSpecHash("article", "published", other), sort: other }, KEY))).toMatchObject({ code: "INVALID_CURSOR" });
    expect(refusal(() => decodeCursor(cursor, "token-a", { specHash: sortSpecHash("article", "draft", sort), sort }, KEY))).toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("a cursor sorted on a field the caller can no longer read never decodes: the sort itself is refused first", () => {
    const secretSort = sortFor(viewer, "secret");
    const secretCursor = encodeCursor({ s: sortSpecHash("article", "published", secretSort), k: ["classified"], id: ID }, "token-a", KEY);
    expect(secretCursor).toBeTruthy();
    // The same token, now with the editor's access: the sort parameter is refused as an unknown field.
    expect(refusal(() => sortFor(editor, "secret"))).toMatchObject({ code: "UNKNOWN_FIELD" });
  });

  it("values must fit the sort fields' types", () => {
    const signedBadType = encodeCursor({ s: spec, k: ["four", "Hello"], id: ID }, "token-a", KEY);
    expect(refusal(() => decodeCursor(signedBadType, "token-a", { specHash: spec, sort }, KEY))).toMatchObject({ code: "INVALID_CURSOR" });
    const nulls = encodeCursor({ s: spec, k: [null, null], id: ID }, "token-a", KEY);
    expect(decodeCursor(nulls, "token-a", { specHash: spec, sort }, KEY).k).toEqual([null, null]);
    const badId = encodeCursor({ s: spec, k: [1, "x"], id: "nope" }, "token-a", KEY);
    expect(refusal(() => decodeCursor(badId, "token-a", { specHash: spec, sort }, KEY))).toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("uses the auth secret when present, so cursors survive restarts and instances", () => {
    const before = process.env.POLYNOVEA_AUTH_SECRET;
    process.env.POLYNOVEA_AUTH_SECRET = "x".repeat(40);
    try {
      const issued = encodeCursor({ s: spec, k: [1, "a"], id: ID }, "token-a");
      expect(decodeCursor(issued, "token-a", { specHash: spec, sort })).toMatchObject({ k: [1, "a"] });
      expect(refusal(() => decodeCursor(issued, "token-a", { specHash: spec, sort }, KEY))).toMatchObject({ code: "INVALID_CURSOR" });
    } finally {
      if (before === undefined) delete process.env.POLYNOVEA_AUTH_SECRET;
      else process.env.POLYNOVEA_AUTH_SECRET = before;
    }
  });
});
