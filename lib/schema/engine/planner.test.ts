import { describe, expect, it } from "vitest";
import { buildMigrationPlan, computePlanHash, computeStageHash, type PlanInput } from "@/lib/schema/engine/planner";
import { describePlan, withSummaries } from "@/lib/schema/engine/describe";
import { shapeForSchema } from "@/lib/schema/engine/columns";
import { hashShape } from "@/lib/schema/engine/hash";
import type { MigrationPlan, PlanStep } from "@/lib/schema/engine/plan";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";

const TABLE = "m_post";
const f = (key: string, type: FieldDefinition["type"] = "text", extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key[0].toUpperCase() + key.slice(1), type, required: false, localized: false, unique: false, ...extra });
const model = (...fields: FieldDefinition[]): CanonicalSchema => ({ name: "Post", apiKey: "post", fields });

function plan(current: CanonicalSchema | null, target: CanonicalSchema | null, extra: Partial<PlanInput> = {}): MigrationPlan {
  const result = buildMigrationPlan({
    workspaceId: "ws", modelId: "model-1", modelApiKey: "post", table: TABLE,
    currentShape: current ? shapeForSchema(TABLE, current) : null, currentSchema: current, targetSchema: target, ...extra,
  });
  if (!result.ok) throw new Error(result.problems.map((p) => p.message).join("; "));
  return result.plan;
}
const problems = (current: CanonicalSchema | null, target: CanonicalSchema | null, extra: Partial<PlanInput> = {}) => {
  const result = buildMigrationPlan({
    workspaceId: "ws", modelId: "model-1", modelApiKey: "post", table: TABLE,
    currentShape: current ? shapeForSchema(TABLE, current) : null, currentSchema: current, targetSchema: target, ...extra,
  });
  return result.ok ? [] : result.problems.map((p) => p.code);
};
const kinds = (p: MigrationPlan, stage?: PlanStep["stage"]) => p.steps.filter((s) => !stage || s.stage === stage).map((s) => s.kind);

const author = f("author", "relation", { relation: { targetModelApiKey: "person", cardinality: "many_to_one", onDelete: "block" } });
const tags = f("tags", "relation", { relation: { targetModelApiKey: "tag", cardinality: "many_to_many", onDelete: "remove_reference" } });

describe("migration plan: field types to columns", () => {
  it("creates a table, then adds each constraint as its own step", () => {
    const p = plan(null, model(f("title", "text", { required: true, unique: true }), f("views", "integer", { index: true }), author, tags));
    expect(kinds(p)).toEqual(["create_table", "set_required", "add_index", "add_index", "add_index", "add_search_index", "add_foreign_key"]);
    const create = p.steps[0] as Extract<PlanStep, { kind: "create_table" }>;
    expect(create.columns.map((c) => [c.name, c.pgType])).toEqual([["title", "text"], ["views", "bigint"], ["author", "uuid"]]);
    expect(p.requiresConfirmation).toBe(false);
    expect(p.baseShapeHash).toBe(hashShape(null));
    expect(p.expandedShapeHash).toBe(p.targetShapeHash);
    expect(p.notes.join(" ")).toMatch(/Tags \(tags\)|"Tags"/);
  });

  it("maps required to 'required when published', unique to a unique index and to-one relations to FKs", () => {
    const shape = shapeForSchema(TABLE, model(f("title", "text", { required: true, unique: true }), author, f("buddy", "relation", {
      relation: { targetModelApiKey: "person", cardinality: "one_to_one", onDelete: "remove_reference" },
    })));
    expect(shape.columns.title).toMatchObject({ requiredWhenPublished: true, unique: true, indexed: false });
    expect(shape.columns.author).toMatchObject({ pgType: "uuid", indexed: true, foreignKey: { onDelete: "restrict" } });
    expect(shape.columns.buddy).toMatchObject({ unique: true, indexed: false, foreignKey: { onDelete: "set_null" } });
  });
});

describe("migration plan: changes", () => {
  const v1 = model(f("title"), f("body", "long_text"), f("price", "integer"));

  it("adds a field without needing confirmation", () => {
    const p = plan(v1, model(...v1.fields, f("summary")));
    expect(kinds(p)).toEqual(["add_column", "add_search_index"]);
    expect(p.steps[0].summary).toBe("Adds a field: Summary (summary) (text)");
    expect(p.requiresConfirmation).toBe(false);
  });

  it("backfills a new required field that has a default before validating it", () => {
    const p = plan(v1, model(...v1.fields, f("status", "text", { required: true, defaultValue: "draft" })));
    expect(kinds(p)).toEqual(["add_column", "backfill_column", "set_required", "add_search_index"]);
    expect(p.steps.find((s) => s.kind === "set_required")!.summary).toMatch(/required when published/);
  });

  it("drops a removed field only in the destructive stage", () => {
    const p = plan(v1, model(f("title"), f("price", "integer")));
    expect(kinds(p, "expand")).toEqual([]);
    expect(kinds(p, "destructive")).toEqual(["drop_column"]);
    expect(p.requiresConfirmation).toBe(true);
    expect(p.expandedShapeHash).toBe(p.baseShapeHash);
    expect(p.targetShapeHash).not.toBe(p.baseShapeHash);
  });

  it("renames only when asked; otherwise a changed key is drop + add with the destructive gate", () => {
    const target = model(f("headline"), f("body", "long_text"), f("price", "integer"));
    const renamed = plan(v1, target, { renames: [{ from: "title", to: "headline" }] });
    expect(kinds(renamed)).toEqual(["rename_column"]);
    expect(renamed.steps[0].summary).toBe("Renames a field: title → Headline (headline) (safe, two steps)");
    expect(renamed.requiresConfirmation).toBe(false);

    const silent = plan(v1, target);
    expect(kinds(silent, "expand")).toEqual(["add_column", "add_search_index"]);
    expect(kinds(silent, "destructive")).toEqual(["drop_column"]);
    expect(silent.requiresConfirmation).toBe(true);
  });

  it("changes a type in place when every value converts, and replaces it (destructive) when not", () => {
    const widen = plan(v1, model(f("title"), f("body", "long_text"), f("price", "number")));
    expect(kinds(widen)).toEqual(["change_type"]);
    expect(widen.steps[0].summary).toMatch(/keeps every value/);

    const narrow = plan(v1, model(f("title", "integer"), f("body", "long_text"), f("price", "integer")));
    expect(kinds(narrow, "expand")).toEqual([]);
    expect(kinds(narrow, "destructive")).toEqual(["replace_column"]);

    const sameColumn = plan(v1, model(f("title", "email"), f("body", "long_text"), f("price", "integer")));
    // An email is matched exactly, not searched: its search index goes.
    expect(kinds(sameColumn)).toEqual(["drop_search_index", "change_field_type"]);
  });

  it("relaxes constraints before a type change and adds new ones after", () => {
    const from = model(f("title", "text", { required: true, unique: true }), author);
    const to = model(f("title", "json", { required: true }), f("author", "text"));
    expect(kinds(plan(from, to))).toEqual(["drop_foreign_key", "drop_index", "drop_index", "drop_search_index", "change_type", "change_type", "add_search_index"]);
  });

  it("removing a to-many relation removes its metadata (permissions, name) with no DDL", () => {
    const p = plan(model(f("title"), tags), model(f("title")));
    expect(kinds(p)).toEqual(["drop_field_metadata"]);
  });

  it("deletes the whole table only in the destructive stage", () => {
    const p = plan(v1, null);
    expect(kinds(p, "destructive")).toEqual(["drop_table"]);
    expect(p.targetShape).toBeNull();
    expect(p.targetSchemaHash).toBeNull();
  });

  it("returns an empty plan when nothing physical changes", () => {
    const p = plan(v1, model(f("title"), f("body", "long_text", { label: "Body copy" }), f("price", "integer")));
    expect(p.steps).toEqual([]);
    expect(p.baseShapeHash).toBe(p.targetShapeHash);
  });
});

describe("migration plan: rules and caps", () => {
  const v1 = model(f("title"));

  it("refuses only keys that break the canonical rule; reserved words and system names get safe columns", () => {
    expect(problems(v1, model(f("Title")))).toEqual(["invalid_name"]);
    expect(problems(v1, model(f("_x")))).toEqual(["invalid_name"]);
    expect(problems(v1, model(f("order"), f("ctid"), f("id"), f("locale")))).toEqual([]);
    expect(problems(null, { ...model(f("title")), apiKey: "select" }, { modelApiKey: "select" })).toEqual([]);
    const p = plan(null, model(f("order"), f("ctid")));
    const columns = Object.values(p.targetShape!.columns).map((c) => [c.field, c.name === c.field]);
    expect(columns.sort()).toEqual([["ctid", false], ["order", true]]);
  });

  it("refuses a field or model name reserved after deletion", () => {
    expect(problems(v1, model(f("title"), f("old")), { reservedFieldNames: ["old"] })).toEqual(["reserved_name"]);
    expect(problems(null, model(f("title")), { reservedModelNames: ["post"] })).toEqual(["reserved_name"]);
    expect(problems(model(f("title")), model(f("old")), { reservedFieldNames: ["old"], renames: [{ from: "title", to: "old" }] })).toContain("reserved_name");
  });

  it("lets a rename go back to a renamed-away name, but not a new field take it", () => {
    const now = model(f("headline"));
    expect(problems(now, model(f("title")), { renamedFieldNames: ["title"], renames: [{ from: "headline", to: "title" }] })).toEqual([]);
    expect(problems(now, model(f("headline"), f("title")), { renamedFieldNames: ["title"] })).toEqual(["reserved_name"]);
  });

  it("enforces the model, field and index caps, which the operator can change", () => {
    // v1's title and body are search-indexed: two indexes.
    const limits = { maxModels: 2, maxFieldsPerModel: 3, maxIndexesPerModel: 2 };
    expect(problems(null, v1, { limits, otherModelCount: 2 })).toEqual(["cap_exceeded"]);
    expect(problems(null, v1, { limits, otherModelCount: 1 })).toEqual([]);
    expect(problems(v1, model(f("a"), f("b"), f("c"), f("d")), { limits })).toEqual(["cap_exceeded"]);
    // Search indexes never count as an error (they fill what is left); real indexes over the cap do.
    expect(problems(v1, model(f("a", "text", { unique: true }), f("b", "text", { index: true })), { limits })).toEqual([]);
    expect(problems(v1, model(f("a", "text", { unique: true }), f("b", "text", { index: true }), f("c", "integer", { index: true })), { limits })).toEqual(["cap_exceeded"]);
    // Defaults: 150 fields is allowed, 151 is not.
    const many = (n: number) => model(...Array.from({ length: n }, (_, i) => f(`field_${i}`, "integer")));
    expect(problems(null, many(150))).toEqual([]);
    expect(problems(null, many(151))).toEqual(["cap_exceeded"]);
  });

  it("refuses impossible renames and api key changes", () => {
    expect(problems(v1, model(f("headline")), { renames: [{ from: "missing", to: "headline" }] })).toEqual(["invalid_rename"]);
    expect(problems(v1, model(f("title"), f("headline")), { renames: [{ from: "title", to: "headline" }] })).toEqual(["invalid_rename"]);
    expect(problems(v1, { ...v1, apiKey: "article" })).toContain("invalid_schema");
    expect(problems(v1, model(f("link", "relation")))).toEqual([]);
    expect(problems(model(f("title"), f("n", "integer")), model(f("title"), f("m", "boolean")), { renames: [{ from: "n", to: "m" }] })).toEqual(["invalid_rename"]);
  });
});

describe("migration plan: search indexes", () => {
  it("search-indexes prose text fields only, and counts them against the index cap", () => {
    const shape = shapeForSchema(TABLE, model(f("title"), f("body", "long_text"), f("notes", "markdown"), f("slug", "slug"), f("email", "email"),
      f("url", "url"), f("kind", "select"), f("rich", "rich_text"), f("views", "integer")));
    expect(Object.values(shape.columns).filter((c) => c.searchIndexed).map((c) => c.field)).toEqual(["title", "body", "notes"]);
    // The flag is absent (not false) elsewhere, so shapes recorded before it keep their hashes.
    expect("searchIndexed" in shape.columns.slug).toBe(false);
  });

  it("never blocks a model: real indexes use the budget first, search indexes take what is left in field order", () => {
    const prose = (n: number, ...extra: FieldDefinition[]) => model(...extra, ...Array.from({ length: n }, (_, i) => f(`t_${i}`, "long_text")));
    const searchIndexed = (p: MigrationPlan) => Object.values(p.targetShape!.columns).filter((c) => c.searchIndexed).map((c) => c.field);
    const real = [f("views", "integer", { index: true }), f("code", "slug", { unique: true }), author];
    const big = plan(null, prose(60, ...real));
    expect(searchIndexed(big).sort()).toEqual(Array.from({ length: 47 }, (_, i) => `t_${i}`).sort());
    expect(big.notes).toContain("13 text fields won't get a search index (index limit reached); they stay searchable, more slowly.");
    expect(kinds(big).filter((k) => k === "add_search_index")).toHaveLength(47);

    // A real index added when the budget is full takes the last search index's place.
    const withIndex = prose(60, ...real, f("rank", "integer", { index: true }));
    const next = buildMigrationPlan({ workspaceId: "ws", modelId: "model-1", modelApiKey: "post", table: TABLE, currentShape: big.targetShape, currentSchema: prose(60, ...real), targetSchema: withIndex });
    if (!next.ok) throw new Error(next.problems[0].message);
    expect(kinds(next.plan)).toEqual(["drop_search_index", "add_column", "add_index"]);
    expect(next.plan.steps[0]).toMatchObject({ column: "t_46" });
    // Only real indexes over the cap are an error.
    expect(problems(null, model(...Array.from({ length: 51 }, (_, i) => f(`n_${i}`, "integer", { index: true }))))).toEqual(["cap_exceeded"]);
  });

  it("adds and removes the search index with the field type, and keeps it through a rename", () => {
    const from = model(f("title"), f("code", "slug"));
    expect(kinds(plan(from, model(f("title", "slug"), f("code", "slug"))))).toEqual(["drop_search_index", "change_field_type"]);
    expect(kinds(plan(from, model(f("title"), f("code", "long_text"))))).toEqual(["change_field_type", "add_search_index"]);
    const renamed = plan(from, model(f("headline"), f("code", "slug")), { renames: [{ from: "title", to: "headline" }] });
    expect(kinds(renamed)).toEqual(["rename_column"]);
    expect(renamed.targetShape!.columns.headline.searchIndexed).toBe(true);
    expect(renamed.steps.map((s) => s.summary)).toHaveLength(1);
    expect(plan(null, model(f("title"))).steps.find((s) => s.kind === "add_search_index")!.summary).toBe("Indexes Title (title) for search");
  });
});

describe("migration plan: hash and plain words", () => {
  const v1 = model(f("title"), f("body", "long_text"));

  it("has a plan hash that is stable, covers the steps and ignores counts and wording", () => {
    const a = plan(v1, model(f("title")));
    const b = plan(v1, model(f("title")));
    expect(a.planHash).toBe(b.planHash);
    expect(computePlanHash(a)).toBe(a.planHash);
    expect(plan(v1, model(f("body", "long_text"))).planHash).not.toBe(a.planHash);
    const counted = withSummaries({ ...a, steps: a.steps.map((s) => ({ ...s, affectedValues: 1240 })) as PlanStep[] }, { modelName: "Post", schemas: [v1] });
    expect(computePlanHash(counted)).toBe(a.planHash);
    expect(computePlanHash({ ...a, steps: [{ ...a.steps[0], table: "m_other" }] as PlanStep[] })).not.toBe(a.planHash);
  });

  it("says how many values a destructive step deletes", () => {
    const p = plan(v1, model(f("title")));
    expect(p.steps[0].summary).toBe("Deletes the field Body (body): deletes every value it holds");
    const counted = withSummaries({ ...p, steps: p.steps.map((s) => ({ ...s, affectedValues: 1240 })) as PlanStep[] }, { modelName: "Post", schemas: [v1] });
    expect(counted.steps[0].summary).toBe("Deletes the field Body (body): deletes 1,240 values");
    const one = withSummaries({ ...p, steps: p.steps.map((s) => ({ ...s, affectedValues: 1 })) as PlanStep[] }, { modelName: "Post", schemas: [v1] });
    expect(one.steps[0].summary).toMatch(/deletes 1 value$/);
  });

  it("explains what blocks a step", () => {
    const p = plan(v1, model(f("title", "text", { required: true, unique: true }), f("body", "long_text")));
    const blocked = withSummaries({ ...p, steps: p.steps.map((s) => ({ ...s, blockingRows: 12 })) as PlanStep[] }, { modelName: "Post", schemas: [v1] });
    expect(blocked.steps.map((s) => s.summary)).toEqual([
      "Makes Title (title) required when published: blocked until 12 published entries have a value",
      "Makes Title (title) unique: blocked until 12 duplicate values are changed",
    ]);
  });
});

describe("migration plan: a field waiting to be deleted", () => {
  it("cannot be re-added until its deletion is confirmed or cancelled", () => {
    // The table still has `body`, but the schema it was last planned to no longer does.
    const table = model(f("title"), f("body", "long_text"));
    const result = buildMigrationPlan({
      workspaceId: "ws", modelId: "model-1", modelApiKey: "post", table: TABLE,
      currentShape: shapeForSchema(TABLE, table), currentSchema: model(f("title")), targetSchema: model(f("title"), f("body", "long_text")),
    });
    expect(result.ok ? [] : result.problems).toEqual([{ code: "pending_deletion", message: 'The field "body" is waiting to be deleted. To use the name again, confirm that deletion on the model page first; its old values will not come back.' }]);
  });
});

describe("plain words: the confirmation", () => {
  it("asks for the model's API key, not its name", () => {
    const p = plan(model(f("title"), f("body")), model(f("title")));
    expect(describePlan(p).at(-1)).toEqual({ stage: "destructive", text: "Type the model's API key (post) to confirm the deletion." });
    expect(describePlan(plan(model(f("title")), model(f("title"), f("body")))).some((line) => /API key/.test(line.text))).toBe(false);
  });
});

describe("stage hashes", () => {
  it("the destructive stage hashes the same from the full plan and when rebuilt after the expand stage", () => {
    const before = model(f("title"), f("body", "long_text"), f("price", "text"), f("old"));
    const after = model(f("headline", "text", { required: true, defaultValue: "x" }), f("body", "long_text"), f("price", "integer"), f("extra", "integer", { unique: true }));
    const full = plan(before, after, { renames: [{ from: "title", to: "headline" }], targetVersionId: "33333333-3333-4333-8333-333333333333" });
    expect(full.steps.some((s) => s.stage === "expand") && full.steps.some((s) => s.stage === "destructive")).toBe(true);

    const result = buildMigrationPlan({
      workspaceId: "ws", modelId: "model-1", modelApiKey: "post", table: TABLE,
      currentShape: full.expandedShape, currentSchema: after, targetSchema: after, targetVersionId: "33333333-3333-4333-8333-333333333333",
    });
    if (!result.ok) throw new Error(result.problems[0].message);
    expect(result.plan.steps.every((s) => s.stage === "destructive")).toBe(true);
    expect(computeStageHash(result.plan, "destructive")).toBe(computeStageHash(full, "destructive"));
    // The shapes carry search indexes (headline and body are prose fields), and still hash the same.
    expect(Object.values(full.targetShape!.columns).filter((c) => c.searchIndexed).map((c) => c.field).sort()).toEqual(["body", "headline"]);
    expect(computeStageHash(full, "expand")).not.toBe(computeStageHash(full, "destructive"));
  });
});
