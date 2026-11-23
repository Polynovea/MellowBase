import { describe, expect, it } from "vitest";
import { hashShape } from "@/lib/schema/engine/hash";
import type { MigrationPlan } from "@/lib/schema/engine/plan";
import { RefusedError } from "@/lib/schema/runner/errors";
import { buildPlan, column, shape, testEngine } from "@/lib/schema/runner/testing/plans";
import { verifyRowAgainstPlan, type LedgerRow } from "@/lib/schema/runner/verify";

const WS = "11111111-1111-4111-8111-111111111111";
const MODEL = "22222222-2222-4222-8222-222222222222";
const engine = testEngine;

const base = shape("m_posts", [column("title", "text")]);
const expanded = shape("m_posts", [column("title", "text"), column("views", "bigint")]);

function plan(overrides: Partial<Parameters<typeof buildPlan>[0]> = {}): MigrationPlan {
  return buildPlan({
    workspaceId: WS, modelId: MODEL, modelApiKey: "posts", table: "m_posts", base, expanded,
    steps: [{ kind: "add_column", stage: "expand", column: column("views", "bigint") }],
    ...overrides,
  });
}

function row(p: MigrationPlan, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: "33333333-3333-4333-8333-333333333333", workspace_id: p.workspaceId, content_model_id: p.modelId,
    model_api_key: p.modelApiKey, table_name: p.table, stage: "expand", status: "pending", plan_hash: p.planHash,
    base_shape_hash: p.baseShapeHash, target_schema_hash: p.targetSchemaHash, plan_json: p, requested_by: null,
    target_version_id: null, confirmed_by: null, confirmed_at: null, attempts: 0, ...overrides,
  };
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RefusedError);
    return (error as RefusedError).code;
  }
  throw new Error("expected a refusal");
}

describe("verifyRowAgainstPlan", () => {
  it("accepts a well-formed expand row and returns only that stage's steps", () => {
    const verified = verifyRowAgainstPlan(row(plan()), engine);
    expect(verified.steps.map(({ step }) => step.kind)).toEqual(["add_column"]);
  });

  it("(a) refuses a plan whose hash does not match its contents", () => {
    const p = plan();
    const tampered = { ...p, steps: [{ ...p.steps[0], column: column("views", "text") }] };
    expect(refusal(() => verifyRowAgainstPlan(row(p, { plan_json: tampered }), engine))).toBe("plan_hash_mismatch");
    expect(refusal(() => verifyRowAgainstPlan(row(p, { plan_hash: "0".repeat(64) }), engine))).toBe("plan_hash_mismatch");
  });

  it("(b) refuses any step aimed at a table other than the model's own content table", () => {
    const publicStep = plan({ steps: [{ kind: "add_column", stage: "expand", column: column("views", "bigint"), table: "admin_users" }] });
    expect(refusal(() => verifyRowAgainstPlan(row(publicStep), engine))).toBe("plan_target_mismatch");
    const qualified = plan({ steps: [{ kind: "add_column", stage: "expand", column: column("views", "bigint"), table: "public.workspaces" }] });
    expect(refusal(() => verifyRowAgainstPlan(row(qualified), engine))).toBe("plan_target_mismatch");
    const wholePlan = buildPlan({
      workspaceId: WS, modelId: MODEL, modelApiKey: "posts", table: "workspaces", base: null, expanded: shape("workspaces", []),
      steps: [{ kind: "drop_column", stage: "destructive", column: "slug" }],
    });
    expect(refusal(() => verifyRowAgainstPlan(row(wholePlan), engine))).toBe("plan_target_mismatch");
    const otherRow = plan();
    // The row's own table_name and model_api_key are untrusted and ignored: the trusted plan decides.
    expect(verifyRowAgainstPlan(row(otherRow, { table_name: "m_other", model_api_key: "forged" }), engine).plan.table).toBe("m_posts");
    expect(refusal(() => verifyRowAgainstPlan(row(otherRow, { content_model_id: WS }), engine))).toBe("plan_target_mismatch");
  });

  it("(c) checks the destructive stage on its own; the confirmation itself is a row (runner.dual.test.ts)", () => {
    const p = plan({
      base: expanded, expanded, target: base,
      steps: [{ kind: "drop_column", stage: "destructive", column: "views" }],
    });
    const destructive = { stage: "destructive", base_shape_hash: p.expandedShapeHash };
    // The row's own confirmed_by/confirmed_at are not evidence of anything: they are ignored.
    expect(verifyRowAgainstPlan(row(p, { ...destructive, confirmed_by: MODEL, confirmed_at: new Date() }), engine).stage).toBe("destructive");
    expect(verifyRowAgainstPlan(row(p, destructive), engine).steps.map(({ step }) => step.kind)).toEqual(["drop_column"]);
  });

  it("refuses data-deleting steps placed in the expand stage", () => {
    const p = plan({ base: expanded, expanded: base, steps: [{ kind: "drop_column", stage: "expand", column: "views" }] });
    expect(refusal(() => verifyRowAgainstPlan(row(p), engine))).toBe("plan_destructive_in_expand");
  });

  it("refuses unknown keys anywhere, so nothing extra (like SQL text) can ride along", () => {
    const p = plan();
    expect(refusal(() => verifyRowAgainstPlan(row(p, { plan_json: { ...p, sql: "drop table x" } }), engine))).toBe("plan_malformed");
    const step = { ...p.steps[0], sql: "drop table x" };
    expect(refusal(() => verifyRowAgainstPlan(row(p, { plan_json: { ...p, steps: [step] } }), engine))).toBe("plan_malformed");
    expect(refusal(() => verifyRowAgainstPlan(row(p, { plan_json: "not json" }), engine))).toBe("plan_malformed");
    expect(refusal(() => verifyRowAgainstPlan(row(p, { plan_json: { ...p, formatVersion: 2 } }), engine))).toBe("plan_malformed");
  });

  it("refuses steps that do not replay to the shapes the plan claims (the engine's validatePlan)", () => {
    const wrongShape = shape("m_posts", [column("title", "text"), column("views", "bigint", { unique: true })]);
    const p = plan({ expanded: wrongShape });
    expect(refusal(() => verifyRowAgainstPlan(row(p), engine))).toBe("invalid_plan");
  });

  it("re-runs the name rules and caps", () => {
    const badName = shape("m_posts", [column("title", "text"), column("select", "bigint")]);
    const p = plan({ expanded: badName, steps: [{ kind: "add_column", stage: "expand", column: column("select", "bigint") }] });
    expect(refusal(() => verifyRowAgainstPlan(row(p), engine))).toBe("plan_name_rejected");
    const injected = shape("m_posts", [column("title", "text"), column('x" text); drop table y; --', "bigint")]);
    const q = plan({ expanded: injected, steps: [{ kind: "add_column", stage: "expand", column: column('x" text); drop table y; --', "bigint") }] });
    expect(["plan_malformed", "plan_name_rejected"]).toContain(refusal(() => verifyRowAgainstPlan(row(q), engine)));
    expect(refusal(() => verifyRowAgainstPlan(row(plan()), engine, { maxModels: 200, maxFieldsPerModel: 1, maxIndexesPerModel: 50 }))).toBe("cap_fields_exceeded");
  });

  it("refuses a row whose base hash is not the stage's starting hash", () => {
    const p = plan();
    expect(refusal(() => verifyRowAgainstPlan(row(p, { base_shape_hash: hashShape(null) }), engine))).toBe("ledger_base_hash_mismatch");
  });
});
