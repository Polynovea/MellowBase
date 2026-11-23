import { describe, expect, it } from "vitest";
import { buildMigrationPlan, computePlanHash, type PlanInput } from "@/lib/schema/engine/planner";
import { withSummaries } from "@/lib/schema/engine/describe";
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
    expect(kinds(p)).toEqual(["create_table", "set_required", "add_index", "add_index", "add_index", "add_foreign_key"]);
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
    expect(kinds(p)).toEqual(["add_column"]);
    expect(p.steps[0].summary).toBe("Adds a field: Summary (summary) (text)");
    expect(p.requiresConfirmation).toBe(false);
  });

  it("backfills a new required field that has a default before validating it", () => {
    const p = plan(v1, model(...v1.fields, f("status", "text", { required: true, defaultValue: "draft" })));
    expect(kinds(p)).toEqual(["add_column", "backfill_column", "set_required"]);
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
    expect(kinds(silent, "expand")).toEqual(["add_column"]);
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
    expect(kinds(sameColumn)).toEqual(["change_field_type"]);
  });

  it("relaxes constraints before a type change and adds new ones after", () => {
    const from = model(f("title", "text", { required: true, unique: true }), author);
    const to = model(f("title", "json", { required: true }), f("author", "text"));
    expect(kinds(plan(from, to))).toEqual(["drop_foreign_key", "drop_index", "drop_index", "change_type", "change_type"]);
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
    const limits = { maxModels: 2, maxFieldsPerModel: 3, maxIndexesPerModel: 1 };
    expect(problems(null, v1, { limits, otherModelCount: 2 })).toEqual(["cap_exceeded"]);
    expect(problems(null, v1, { limits, otherModelCount: 1 })).toEqual([]);
    expect(problems(v1, model(f("a"), f("b"), f("c"), f("d")), { limits })).toEqual(["cap_exceeded"]);
    expect(problems(v1, model(f("a", "text", { unique: true }), f("b", "text", { index: true })), { limits })).toEqual(["cap_exceeded"]);
    // Defaults: 150 fields is allowed, 151 is not.
    const many = (n: number) => model(...Array.from({ length: n }, (_, i) => f(`field_${i}`)));
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
