// Security review blocker: the worker never executes a plan from the ledger. It rebuilds the plan from
// trusted state (content_model_tables, the target version, the model row) and compares hashes.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { getDb } from "@/lib/db/index";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { applyDestructiveStage, applyExpandStage, expectedConfirmation, loadModelTable } from "@/lib/schema/engine/apply";
import { computePlanHash, computeStageHash } from "@/lib/schema/engine/planner";
import { assertRequestedPlan, buildPlanForLedgerRequest, buildPlanFromTrustedState } from "@/lib/schema/engine/trusted";
import type { MigrationPlan, PlanStep } from "@/lib/schema/engine/plan";
import { ownerDb, TEST_LIMITS, uniqueKey } from "@/lib/schema/engine/testing";
import { applyChange, createModel, getModel } from "@/lib/schema/modelService";

const field = (key: string, type = "text") => ({ key, label: key, type, required: false, localized: false, unique: false });

describeWithDatabase("plans rebuilt from trusted state", (backend) => {
  let owner: Kysely<DB>;
  beforeAll(() => { owner = ownerDb(); });
  afterAll(async () => { await owner.destroy(); });

  async function model(fields = [field("title"), field("secret")]) {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const apiKey = uniqueKey("post");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Post", apiKey, fields } });
    if (!created.ok) throw new Error(created.error);
    return { workspaceId, adminUserId, apiKey, modelId: created.data.model.id, v1: created.data.version.id };
  }
  const rebuild = (db: Kysely<DB>, input: Parameters<typeof buildPlanFromTrustedState>[1]) => buildPlanFromTrustedState(db, { limits: TEST_LIMITS, ...input });
  const workerCheck = (input: Parameters<typeof assertRequestedPlan>[1]) => owner.transaction().execute((trx) => assertRequestedPlan(trx, { limits: TEST_LIMITS, ...input }));
  const errorOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
  const forge = (plan: MigrationPlan, change: (copy: MigrationPlan) => void) => {
    const copy = JSON.parse(JSON.stringify(plan)) as MigrationPlan;
    change(copy);
    copy.planHash = computePlanHash(copy);
    return copy;
  };

  it("an honest request: the worker's rebuilt plan hashes exactly as the request's, through both stages", async () => {
    const m = await model();
    const request = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand" });
    const rebuilt = await workerCheck({ contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand", requestedPlanHash: computeStageHash(request, "expand") });
    expect(rebuilt.planHash).toBe(request.planHash);
    await applyExpandStage(owner, { plan: rebuilt, requestedBy: m.adminUserId, limits: TEST_LIMITS });
    expect((await loadModelTable(getDb(), m.modelId))?.appliedVersionId).toBe(m.v1);

    const current = (await getModel(m.workspaceId, m.modelId))!;
    const changed = await applyChange({ model: current, proposedSchema: { name: "Post", apiKey: m.apiKey, fields: [field("headline"), field("body")] }, acknowledgeUnsafe: true, actorAdminUserId: m.adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    const v2 = changed.data.version.id;
    const renames = [{ from: "title", to: "headline" }];

    const early = await errorOf(rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: v2, renames, stage: "destructive" }));
    expect(early).toMatchObject({ code: "stage_not_ready" });

    const request2 = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: v2, renames, stage: "expand" });
    expect(request2.steps.map((s) => s.kind)).toEqual(["rename_column", "add_column", "drop_column"]);
    // The request stores one stage hash per ledger row, both computed from the full plan now.
    const expandHash = computeStageHash(request2, "expand");
    const destructiveHash = computeStageHash(request2, "destructive");
    const rebuilt2 = await owner.transaction().execute((trx) => buildPlanForLedgerRequest(trx, {
      content_model_id: m.modelId, target_version_id: v2, stage: "expand", plan_hash: expandHash, renames,
    }, { limits: TEST_LIMITS }));
    const { awaitingConfirmationId } = await applyExpandStage(owner, { plan: rebuilt2, requestedBy: m.adminUserId, limits: TEST_LIMITS });

    // The destructive stage is planned again from the table as it is now, on both sides.
    const request3 = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: v2, stage: "destructive" });
    expect(request3.steps.map((s) => [s.stage, s.kind])).toEqual([["destructive", "drop_column"]]);
    const rebuilt3 = await workerCheck({ contentModelId: m.modelId, targetVersionId: v2, renames, stage: "destructive", requestedPlanHash: destructiveHash });
    expect(rebuilt3.planHash).toBe(request3.planHash);
    // The stage hash taken from the full plan before expand equals the one rebuilt after it.
    expect(computeStageHash(rebuilt3, "destructive")).toBe(destructiveHash);
    expect(await expectedConfirmation(getDb(), m.modelId)).toBe(m.apiKey);
    await applyDestructiveStage(owner, { ledgerId: awaitingConfirmationId!, confirmation: m.apiKey, confirmedBy: m.adminUserId });
    expect(Object.values((await loadModelTable(getDb(), m.modelId))!.shape.columns).map((c) => c.field).sort()).toEqual(["body", "headline"]);
  });

  it("refuses a deletion planned for an older version once a newer version keeps the field", async () => {
    const m = await model();
    const first = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand" });
    await applyExpandStage(owner, { plan: first, requestedBy: null, limits: TEST_LIMITS });
    const save = async (fields: ReturnType<typeof field>[]) => {
      const changed = await applyChange({ model: (await getModel(m.workspaceId, m.modelId))!, proposedSchema: { name: "Post", apiKey: m.apiKey, fields }, acknowledgeUnsafe: true, actorAdminUserId: m.adminUserId });
      if (!changed.ok || !changed.data.version) throw new Error("version not created");
      return changed.data.version.id;
    };
    const v2 = await save([field("title")]);
    const deletion = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: v2, stage: "expand" });
    const destructiveHash = computeStageHash(deletion, "destructive");
    await applyExpandStage(owner, { plan: await workerCheck({ contentModelId: m.modelId, targetVersionId: v2, stage: "expand", requestedPlanHash: computeStageHash(deletion, "expand") }), requestedBy: null, limits: TEST_LIMITS });
    await save([field("title"), field("secret")]);
    expect(await errorOf(workerCheck({ contentModelId: m.modelId, targetVersionId: v2, stage: "destructive", requestedPlanHash: destructiveHash }))).toMatchObject({ code: "stale_plan" });
    expect(Object.values((await loadModelTable(getDb(), m.modelId))!.shape.columns).map((c) => c.field).sort()).toEqual(["secret", "title"]);
  });

  it("refuses a ledger row whose plan targets another model's table, or another model's version", async () => {
    const a = await model();
    const b = await model();
    const planB = await rebuild(getDb(), { contentModelId: b.modelId, targetVersionId: b.v1, stage: "expand" });
    await applyExpandStage(owner, { plan: planB, requestedBy: null, limits: TEST_LIMITS });
    const planA = await rebuild(getDb(), { contentModelId: a.modelId, targetVersionId: a.v1, stage: "expand" });

    const pointed = forge(planA, (copy) => { copy.table = planB.table; for (const step of copy.steps) step.table = planB.table; });
    expect(await errorOf(workerCheck({ contentModelId: a.modelId, targetVersionId: a.v1, stage: "expand", requestedPlanHash: computeStageHash(pointed, "expand") }))).toMatchObject({ code: "stale_plan" });
    expect(await errorOf(workerCheck({ contentModelId: a.modelId, targetVersionId: b.v1, stage: "expand", requestedPlanHash: computeStageHash(planA, "expand") }))).toMatchObject({ code: "not_found" });
    expect(await loadModelTable(getDb(), a.modelId)).toBeNull();
  });

  it("refuses a ledger row with a drop_table the target version does not imply", async () => {
    const m = await model();
    const plan = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand" });
    await applyExpandStage(owner, { plan, requestedBy: null, limits: TEST_LIMITS });

    const dropped = forge(plan, (copy) => { copy.steps = [{ kind: "drop_table", stage: "destructive", table: copy.table, summary: "" } as PlanStep]; copy.requiresConfirmation = true; });
    expect(await errorOf(workerCheck({ contentModelId: m.modelId, targetVersionId: m.v1, stage: "destructive", requestedPlanHash: computeStageHash(dropped, "destructive") }))).toMatchObject({ code: "stale_plan" });
    expect(await errorOf(workerCheck({ contentModelId: m.modelId, targetVersionId: null, stage: "destructive", requestedPlanHash: computeStageHash(dropped, "destructive") }))).toMatchObject({ code: "invalid_plan" });
    expect(await loadModelTable(getDb(), m.modelId)).not.toBeNull();
  });

  it("re-validates requested renames against both schemas", async () => {
    const m = await model([field("title"), field("count", "integer")]);
    const plan = await rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand" });
    await applyExpandStage(owner, { plan, requestedBy: null, limits: TEST_LIMITS });
    const current = (await getModel(m.workspaceId, m.modelId))!;
    const changed = await applyChange({ model: current, proposedSchema: { name: "Post", apiKey: m.apiKey, fields: [field("title"), field("flag", "boolean")] }, acknowledgeUnsafe: true, actorAdminUserId: m.adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    for (const renames of [[{ from: "count", to: "flag" }], [{ from: "missing", to: "flag" }], [{ from: "title", to: "flag" }]]) {
      expect(await errorOf(rebuild(getDb(), { contentModelId: m.modelId, targetVersionId: changed.data.version.id, renames, stage: "expand" }))).toMatchObject({ code: "invalid_plan" });
    }
  });
});
