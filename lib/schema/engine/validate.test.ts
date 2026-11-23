import { describe, expect, it } from "vitest";
import { shapeForSchema } from "@/lib/schema/engine/columns";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import type { MigrationPlan, PlanStep } from "@/lib/schema/engine/plan";
import { buildMigrationPlan, computePlanHash } from "@/lib/schema/engine/planner";
import { validatePlan } from "@/lib/schema/engine/validate";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";

const WS = "11111111-1111-4111-8111-111111111111";
const MODEL = "22222222-2222-4222-8222-222222222222";
const f = (key: string, extra: Partial<FieldDefinition> = {}): FieldDefinition => ({ key, label: key, type: "text", required: false, localized: false, unique: false, ...extra });
const model = (...fields: FieldDefinition[]): CanonicalSchema => ({ name: "Post", apiKey: "post", fields });

function plan(current: CanonicalSchema | null, target: CanonicalSchema | null): MigrationPlan {
  const result = buildMigrationPlan({
    workspaceId: WS, modelId: MODEL, modelApiKey: "post", table: "m_post",
    currentShape: current ? shapeForSchema("m_post", current) : null, currentSchema: current, targetSchema: target,
  });
  if (!result.ok) throw new Error(result.problems[0].message);
  return JSON.parse(JSON.stringify(result.plan)) as MigrationPlan; // as read back from the ledger
}
/** A forger who knows the hash function: change the plan, then recompute its hash. */
const forge = (p: MigrationPlan, change: (p: MigrationPlan) => void): MigrationPlan => {
  const copy = JSON.parse(JSON.stringify(p)) as MigrationPlan;
  change(copy);
  copy.planHash = computePlanHash(copy);
  return copy;
};
const refusal = (p: MigrationPlan, limits?: Parameters<typeof validatePlan>[1]) => {
  try {
    validatePlan(p, limits);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaEngineError);
    return (error as SchemaEngineError).code;
  }
};

describe("validatePlan (plans read back from the ledger)", () => {
  const v1 = model(f("title"), f("body"));

  it("accepts plans the planner made, after a JSON round trip", () => {
    expect(refusal(plan(null, v1))).toBeNull();
    expect(refusal(plan(v1, model(f("title"))))).toBeNull();
    expect(refusal(plan(v1, model(f("title", { required: true, defaultValue: "x", unique: true }), f("body", { type: "integer" }))))).toBeNull();
    expect(refusal(plan(v1, null))).toBeNull();
  });

  it("refuses a plan whose hash no longer matches", () => {
    const p = plan(v1, model(f("title")));
    expect(refusal({ ...p, steps: p.steps.map((s) => ({ ...s, table: "m_other" })) as PlanStep[] })).toBe("invalid_plan");
  });

  it("refuses a forged plan that moves a deletion into the unconfirmed stage, even with a valid hash", () => {
    const p = plan(v1, model(f("title")));
    expect(refusal(forge(p, (c) => { c.steps[0].stage = "expand"; c.requiresConfirmation = false; c.expandedShape = c.targetShape; c.expandedShapeHash = c.targetShapeHash; }))).toBe("invalid_plan");
  });

  it("refuses forged names, types, other tables, out-of-order stages and claimed shapes the steps do not reach", () => {
    const p = plan(v1, model(f("title"), f("body"), f("extra")));
    expect(refusal(forge(p, (c) => { (c.steps[0] as Extract<PlanStep, { kind: "add_column" }>).column.name = "order"; }))).toBe("invalid_plan");
    expect(refusal(forge(p, (c) => { (c.steps[0] as Extract<PlanStep, { kind: "add_column" }>).column.pgType = "text; drop" as never; }))).toBe("invalid_plan");
    expect(refusal(forge(p, (c) => { c.table = "users"; }))).toBe("invalid_plan");
    expect(refusal(forge(p, (c) => { c.modelApiKey = "select"; }))).toBe("invalid_plan");
    expect(refusal(forge(p, (c) => { c.targetShapeHash = c.baseShapeHash; c.targetShape = c.baseShape; }))).toBe("invalid_plan");

    const mixed = plan(v1, model(f("title"), f("extra")));
    expect(mixed.steps.map((s) => s.stage)).toEqual(["expand", "destructive"]);
    expect(refusal(forge(mixed, (c) => { c.steps.reverse(); }))).toBe("invalid_plan");
  });

  it("applies the operator's caps to the plan's final shape", () => {
    const p = plan(null, model(f("a", { unique: true }), f("b", { index: true }), f("c")));
    expect(refusal(p, { limits: { maxModels: 200, maxFieldsPerModel: 2, maxIndexesPerModel: 50 } })).toBe("cap_exceeded");
    expect(refusal(p, { limits: { maxModels: 200, maxFieldsPerModel: 150, maxIndexesPerModel: 1 } })).toBe("cap_exceeded");
  });
});
