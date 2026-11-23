// The worker end to end with the real engine: every plan it runs is rebuilt from trusted state
// (content_model_tables, the target content_model_versions row, the model row and the re-validated
// renames) by the engine's assertRequestedPlan, and must hash exactly as the ledger row asked. Models
// and versions are made the way the CMS makes them (modelService, as the app role).
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/index";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { buildPlanFromTrustedState, type MigrationPlan } from "@/lib/schema/engine";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { applyChange, createModel, getModel } from "@/lib/schema/modelService";
import { kyselyOn } from "@/lib/schema/runner/engine";
import { productionEngine } from "@/lib/schema/runner/engineAdapter";
import { confirmPlanStage, requestPlanStage } from "@/lib/schema/runner/request";
import { runNextStage } from "@/lib/schema/runner/runner";
import { buildPlan, column, shape, TEST_LIMITS } from "@/lib/schema/runner/testing/plans";
import { connect } from "@/lib/schema/runner/testing/dualFixtures";
import type pg from "pg";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const field = (key: string, type = "text") => ({ key, label: key, type, required: false, localized: false, unique: false });
const engine = productionEngine(TEST_LIMITS);

describeWithDatabase("the worker runs only plans rebuilt from trusted state", (backend) => {
  let session: pg.Client;
  let app: pg.Client;
  beforeAll(async () => { [session, app] = await Promise.all([connect("owner"), connect("app")]); });
  afterAll(async () => { await Promise.all([session?.end(), app?.end()]); });

  async function model(fields = [field("title"), field("secret")]) {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    const apiKey = uniqueKey("post");
    const created = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Post", apiKey, fields } });
    if (!created.ok) throw new Error(created.error);
    return { workspaceId, adminUserId, apiKey, modelId: created.data.model.id, v1: created.data.version.id };
  }
  /** What the request side does: plan from trusted state (read-only access is enough), then queue it. */
  async function request(m: { modelId: string; adminUserId: string }, targetVersionId: string | null, stage: "expand" | "destructive", renames: Array<{ from: string; to: string }> = []) {
    const plan = await buildPlanFromTrustedState(getDb(), { contentModelId: m.modelId, targetVersionId, renames, stage, limits: TEST_LIMITS });
    const { ledgerId } = await requestPlanStage(kyselyOn(app), { plan, stage, requestedBy: m.adminUserId, targetVersionId, renames });
    return { ledgerId, plan };
  }
  const run = (modelId: string) => runNextStage(session, { engine, workerId: "trusted-test", releaseId: "test-release", limits: TEST_LIMITS, modelId });
  const columns = async (modelId: string) => {
    const [row] = await backend.query<{ table_name: string; fields: string[] }>(
      "select table_name, (select array_agg(c->>'field' order by c->>'field') from jsonb_each(applied_shape->'columns') as e(k, c)) as fields from content_model_tables where content_model_id = $1",
      [modelId],
    );
    return row ?? null;
  };

  it("an honest change runs through both stages: create, rename + add, then the confirmed deletion", async () => {
    const m = await model();
    const first = await request(m, m.v1, "expand");
    expect(await run(m.modelId)).toEqual({ ledgerId: first.ledgerId, outcome: "succeeded" });
    expect((await columns(m.modelId))?.fields).toEqual(["secret", "title"]);

    const current = (await getModel(m.workspaceId, m.modelId))!;
    const changed = await applyChange({ model: current, proposedSchema: { name: "Post", apiKey: m.apiKey, fields: [field("headline"), field("body")] }, acknowledgeUnsafe: true, actorAdminUserId: m.adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    const v2 = changed.data.version.id;
    const renames = [{ from: "title", to: "headline" }];

    const second = await request(m, v2, "expand", renames);
    expect(second.plan.steps.map((step) => step.kind)).toEqual(["rename_column", "add_column", "drop_column"]);
    expect(await run(m.modelId)).toEqual({ ledgerId: second.ledgerId, outcome: "succeeded" });

    const third = await request(m, v2, "destructive");
    expect(await run(m.modelId)).toBeNull();
    await confirmPlanStage(kyselyOn(app), { ledgerId: third.ledgerId, confirmedBy: m.adminUserId, typedApiKey: m.apiKey });
    expect(await run(m.modelId)).toEqual({ ledgerId: third.ledgerId, outcome: "succeeded" });
    expect((await columns(m.modelId))?.fields).toEqual(["body", "headline"]);
  });

  it("refuses a request whose hash is not the rebuilt plan's (stale_plan); nothing runs", async () => {
    const m = await model();
    const honest = await buildPlanFromTrustedState(getDb(), { contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand", limits: TEST_LIMITS });
    const forged: MigrationPlan = { ...honest, planHash: "f".repeat(64) };
    const { ledgerId } = await requestPlanStage(kyselyOn(app), { plan: forged, stage: "expand", requestedBy: m.adminUserId, targetVersionId: m.v1 });
    expect(await run(m.modelId)).toEqual({ ledgerId, outcome: "refused", code: "stale_plan" });
    expect(await columns(m.modelId)).toBeNull();
  });

  it("(e) a correctly hashed drop_table the target version does not imply is refused; the table stays", async () => {
    const m = await model();
    const first = await request(m, m.v1, "expand");
    expect(await run(m.modelId)).toEqual({ ledgerId: first.ledgerId, outcome: "succeeded" });
    const recorded = await columns(m.modelId);
    const tableShape = shape(recorded!.table_name, [column("title", "text"), column("secret", "text")]);
    const dropTable = buildPlan({
      workspaceId: m.workspaceId, modelId: m.modelId, modelApiKey: m.apiKey, table: recorded!.table_name,
      base: tableShape, expanded: tableShape, target: null, steps: [{ kind: "drop_table", stage: "destructive" }],
    });

    // With the current version as the target: the rebuilt plan is not a drop_table, so the hash differs.
    const withVersion = await requestPlanStage(kyselyOn(app), { plan: dropTable, stage: "destructive", requestedBy: m.adminUserId, targetVersionId: m.v1 });
    await confirmPlanStage(kyselyOn(app), { ledgerId: withVersion.ledgerId, confirmedBy: m.adminUserId, typedApiKey: m.apiKey });
    const refused = await run(m.modelId);
    expect(refused).toMatchObject({ ledgerId: withVersion.ledgerId, outcome: "refused" });
    expect(["stale_plan", "invalid_plan"]).toContain((refused as { code: string }).code);

    // With no target version (delete the model's table): refused while the model is not archived.
    const noVersion = await requestPlanStage(kyselyOn(app), { plan: dropTable, stage: "destructive", requestedBy: m.adminUserId, targetVersionId: null });
    await confirmPlanStage(kyselyOn(app), { ledgerId: noVersion.ledgerId, confirmedBy: m.adminUserId, typedApiKey: m.apiKey });
    expect(await run(m.modelId)).toEqual({ ledgerId: noVersion.ledgerId, outcome: "refused", code: "invalid_plan" });

    const [still] = await backend.query<{ found: string | null }>("select to_regclass($1)::text as found", [`content.${recorded!.table_name}`]);
    expect(still.found).not.toBeNull();
  });

  it("the app cannot rewrite the version history the worker rebuilds from", async () => {
    const m = await model();
    await expect(app.query("update content_model_versions set schema_json = '{}'::jsonb where id = $1", [m.v1])).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("delete from content_model_versions where id = $1", [m.v1])).rejects.toMatchObject({ code: "42501" });
    const [kept] = await backend.query<{ n: number }>("select count(*)::int as n from content_model_versions where id = $1", [m.v1]);
    expect(kept.n).toBe(1);
  });
});
