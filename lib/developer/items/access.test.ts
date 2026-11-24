import { describe, expect, it } from "vitest";
import { canUseField, decideModelAccess, effectiveLimits, lookupFor, mergeLimitOverrides, sanitise } from "@/lib/developer/items/access";
import { ItemsApiError } from "@/lib/developer/items/errors";
import { HARD_LIMITS } from "@/lib/developer/items/types";
import { ARTICLE, PERSON, ROLE, RULES, WS, accessesFor, tokenPrincipal } from "@/lib/developer/items/testing/principals";

const codeOf = (fn: () => unknown) => {
  try { fn(); return null; } catch (error) { return error instanceof ItemsApiError ? { code: error.code, status: error.status, details: error.details } : String(error); }
};

describe("resolveModelAccess (the decision)", () => {
  it("hides a field from a role with a can_read=false row, in every reading channel", () => {
    const access = decideModelAccess(tokenPrincipal(), ARTICLE, RULES);
    expect(access.readable.has("secret")).toBe(false);
    expect(access.readable.has("title")).toBe(true);
    for (const channel of ["output", "filter", "sort", "search", "expand", "webhook", "preview", "mcp", "schedule"] as const) {
      expect(canUseField(access, "secret", channel)).toBe(false);
    }
    expect(access.restricted).toBe(true);
  });

  it("a role with no row falls back to the model level; several roles are a union", () => {
    expect(decideModelAccess(tokenPrincipal({ roleIds: [ROLE.viewer], roleKeys: ["viewer"] }), ARTICLE, RULES).readable.has("secret")).toBe(true);
    const both = decideModelAccess(tokenPrincipal({ roleIds: [ROLE.editor, ROLE.viewer], roleKeys: ["editor", "viewer"] }), ARTICLE, RULES);
    expect(both.readable.has("secret")).toBe(true);
    expect(both.restricted).toBe(false);
  });

  it("rules of other roles never apply", () => {
    const viewer = decideModelAccess(tokenPrincipal({ roleIds: [ROLE.viewer], roleKeys: ["viewer"] }), ARTICLE, RULES);
    expect(viewer.writable.has("title")).toBe(true);
  });

  it("write needs read: a can_write row on an unreadable field writes nothing; read-only rows block writes", () => {
    const writer = decideModelAccess(tokenPrincipal({ roleIds: [ROLE.writer], roleKeys: ["writer"] }), ARTICLE, RULES);
    expect(writer.readable.has("secret")).toBe(false);
    expect(writer.writable.has("secret")).toBe(false);
    expect(writer.readable.has("title")).toBe(true);
    expect(writer.writable.has("title")).toBe(false);
    expect(writer.writable.has("rating")).toBe(true);
  });

  it("the owner role bypasses field rules", () => {
    const owner = decideModelAccess(tokenPrincipal({ roleIds: [ROLE.owner, ROLE.editor], roleKeys: ["owner", "editor"] }), ARTICLE, RULES);
    expect(owner.readable.has("secret")).toBe(true);
    expect(owner.writable.has("secret")).toBe(true);
  });

  it("model level: scope, allowed models, workspace and the schema policy", () => {
    expect(decideModelAccess(tokenPrincipal({ scopes: new Set(["content.write"]) }), ARTICLE, []).canRead).toBe(false);
    expect(decideModelAccess(tokenPrincipal({ scopes: new Set(["content.read"]) }), ARTICLE, []).canWrite).toBe(false);
    expect(decideModelAccess(tokenPrincipal({ allowedModels: ["person"] }), ARTICLE, []).canRead).toBe(false);
    expect(decideModelAccess(tokenPrincipal({ allowedModels: [] }), ARTICLE, []).canRead).toBe(true);
    expect(decideModelAccess(tokenPrincipal({ workspaceId: "00000000-0000-4000-8000-0000000000ff" }), ARTICLE, []).canRead).toBe(false);
    const policed = { ...ARTICLE, schema: { ...ARTICLE.schema, permissions: [{ role: "viewer", operations: ["read" as const] }] } };
    expect(decideModelAccess(tokenPrincipal(), policed, []).canRead).toBe(false);
    expect(decideModelAccess(tokenPrincipal({ roleKeys: ["viewer"] }), policed, []).canRead).toBe(true);
    // A token without a role keeps today's behaviour: no schema policy.
    expect(decideModelAccess(tokenPrincipal({ applyModelPolicy: false }), policed, []).canRead).toBe(true);
  });

  it("an unreadable model exposes no fields at all, not even system ones", () => {
    const none = decideModelAccess(tokenPrincipal({ allowedModels: ["person"] }), ARTICLE, []);
    expect(none.fields.size).toBe(0);
    expect(none.readable.size).toBe(0);
  });

  it("admins are judged by their permission keys", () => {
    const admin = decideModelAccess(tokenPrincipal({ kind: "admin", scopes: new Set(["content.entry.read", "content.entry.edit"]) }), ARTICLE, RULES);
    expect(admin.canRead).toBe(true);
    expect(admin.canWrite).toBe(true);
    expect(admin.canPublish).toBe(false);
    expect(admin.readable.has("secret")).toBe(false);
  });
});

describe("lookupFor: unknown and unreadable are the same answer", () => {
  it("returns null for a missing field, a hidden field, a field of a hidden model and prototype keys", () => {
    const lookup = lookupFor(accessesFor(tokenPrincipal()));
    expect(lookup.field("article", "title")).toMatchObject({ key: "title", cls: "text" });
    expect(lookup.field("article", "secret")).toBeNull();
    expect(lookup.field("article", "nope")).toBeNull();
    expect(lookup.field("person", "salary")).toBeNull();
    expect(lookup.field("unknown_model", "title")).toBeNull();
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(lookup.field("article", key)).toBeNull();
    expect(lookup.field("article", "createdAt")).toMatchObject({ system: true, cls: "ordered" });
    expect(lookup.field("article", "related")).toMatchObject({ cls: "none", relation: { target: "article", toMany: true } });
  });
});

describe("sanitise (one sanitiser, both directions)", () => {
  const access = decideModelAccess(tokenPrincipal({ roleIds: [ROLE.writer], roleKeys: ["writer"] }), ARTICLE, RULES);

  it("out: drops hidden and unknown keys, never throws", () => {
    expect(sanitise(access, { title: "T", secret: "S", ghost: 1, rating: 3 }, "out")).toEqual({ title: "T", rating: 3 });
    expect(sanitise(access, null, "out")).toEqual({});
  });

  it("in: unknown and hidden keys are rejected identically; read-only keys are 403; nothing is dropped silently", () => {
    const hidden = codeOf(() => sanitise(access, { secret: "x" }, "in"));
    const missing = codeOf(() => sanitise(access, { ghost: "x" }, "in"));
    expect(hidden).toMatchObject({ code: "UNKNOWN_FIELD", status: 400 });
    expect(missing).toMatchObject({ code: "UNKNOWN_FIELD", status: 400 });
    expect(Object.keys((hidden as { details: object }).details)).toEqual(Object.keys((missing as { details: object }).details));
    expect(codeOf(() => sanitise(access, { title: "x" }, "in"))).toMatchObject({ code: "FIELD_READ_ONLY", status: 403 });
    expect(codeOf(() => sanitise(access, { rating: 2, ghost: 1, other: 2 }, "in"))).toMatchObject({ code: "UNKNOWN_FIELD", details: { fields: ["ghost", "other"] } });
    expect(sanitise(access, { rating: 2 }, "in")).toEqual({ rating: 2 });
    expect(codeOf(() => sanitise(access, [1], "in"))).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("limits per role", () => {
  it("overrides only lower the caps, and never below the minimums", () => {
    expect(effectiveLimits()).toEqual(HARD_LIMITS);
    expect(effectiveLimits({ pageSize: 10, statementTimeoutMs: 999_999, joins: -5 })).toMatchObject({ pageSize: 10, defaultPageSize: 10, statementTimeoutMs: 5_000, joins: 0 });
  });

  it("several roles: the most generous override wins; a role without overrides means the caps", () => {
    expect(mergeLimitOverrides([{ pageSize: 10 }, { pageSize: 50 }])).toEqual({ pageSize: 50 });
    expect(mergeLimitOverrides([{ pageSize: 10 }, null])).toBeUndefined();
    expect(mergeLimitOverrides([])).toBeUndefined();
  });

  it("a principal's overrides reach its access", () => {
    expect(decideModelAccess(tokenPrincipal({ limitOverrides: { pageSize: 7 } }), PERSON, []).limits.pageSize).toBe(7);
    expect(WS).toBeTruthy();
  });
});
