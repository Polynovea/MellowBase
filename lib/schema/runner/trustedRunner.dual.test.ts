// The worker end to end with the real engine: every plan it runs is rebuilt from trusted state
// (content_model_tables, the target content_model_versions row, the model row and the re-validated
// renames) by the engine's assertRequestedPlan, and must hash exactly as the ledger row asked. Models
// and versions are made the way the CMS makes them (modelService, as the app role).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/index";
import { describeWithDatabase } from "@/lib/db/testing/database";
import { buildPlanFromTrustedState, type MigrationPlan } from "@/lib/schema/engine";
import { uniqueKey } from "@/lib/schema/engine/testing";
import { applyChange, createModel, getModel } from "@/lib/schema/modelService";
import { kyselyOn } from "@/lib/schema/runner/engine";
import { productionEngine } from "@/lib/schema/runner/engineAdapter";
import { cancelPlanStage, confirmPlanStage, requestPlanStage, requestSchemaChange } from "@/lib/schema/runner/request";
import { runNextStage } from "@/lib/schema/runner/runner";
import { buildPlan, column, shape, TEST_LIMITS } from "@/lib/schema/runner/testing/plans";
import { connect } from "@/lib/schema/runner/testing/dualFixtures";
import type pg from "pg";
import { spawn } from "node:child_process";

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
    // Since Phase 4 a save queues its change itself; these tests queue their own, so cancel that one.
    for (const id of [created.data.schemaChange.expandLedgerId, created.data.schemaChange.destructiveLedgerId]) {
      if (id) await cancelPlanStage(kyselyOn(app), { ledgerId: id, cancelledBy: adminUserId });
    }
    return { workspaceId, adminUserId, apiKey, modelId: created.data.model.id, v1: created.data.version.id };
  }
  /** What the CMS does: plan the change from trusted state as the app role and queue its stages. */
  const request = (m: { modelId: string; adminUserId: string }, targetVersionId: string | null, renames: Array<{ from: string; to: string }> = []) =>
    requestSchemaChange(kyselyOn(app), { contentModelId: m.modelId, targetVersionId, renames, requestedBy: m.adminUserId, limits: TEST_LIMITS });
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
    const first = await request(m, m.v1);
    expect(first.destructiveLedgerId).toBeNull();
    expect(await run(m.modelId)).toEqual({ ledgerId: first.expandLedgerId, outcome: "succeeded" });
    expect((await columns(m.modelId))?.fields).toEqual(["secret", "title"]);

    const current = (await getModel(m.workspaceId, m.modelId))!;
    const changed = await applyChange({ model: current, proposedSchema: { name: "Post", apiKey: m.apiKey, fields: [field("headline"), field("body")] }, acknowledgeUnsafe: true, actorAdminUserId: m.adminUserId });
    if (!changed.ok || !changed.data.version) throw new Error("version 2 not created");
    const v2 = changed.data.version.id;
    const renames = [{ from: "title", to: "headline" }];

    // One request queues both stages; each row holds its own stage's hash, the renames only on expand.
    const second = await request(m, v2, renames);
    expect(second.plan.steps.map((step) => step.kind)).toEqual(["rename_column", "add_column", "add_search_index", "drop_column"]);
    const [destructiveRow] = await backend.query<{ status: string; renames: unknown }>("select status, renames from schema_migration_ledger where id = $1", [second.destructiveLedgerId]);
    expect(destructiveRow).toEqual({ status: "awaiting_confirmation", renames: [] });
    expect(await run(m.modelId)).toEqual({ ledgerId: second.expandLedgerId, outcome: "succeeded" });

    // The destructive stage is rebuilt from the table as it is now and still hashes as requested.
    expect(await run(m.modelId)).toBeNull();
    await confirmPlanStage(kyselyOn(app), { ledgerId: second.destructiveLedgerId!, confirmedBy: m.adminUserId, typedApiKey: m.apiKey });
    expect(await run(m.modelId)).toEqual({ ledgerId: second.destructiveLedgerId, outcome: "succeeded" });
    expect((await columns(m.modelId))?.fields).toEqual(["body", "headline"]);
  });

  it("refuses a request whose hash is not the rebuilt plan's (stale_plan); nothing runs", async () => {
    const m = await model();
    const honest = await buildPlanFromTrustedState(getDb(), { contentModelId: m.modelId, targetVersionId: m.v1, stage: "expand", limits: TEST_LIMITS });
    // Any change to what the stage says changes its hash: the rebuilt stage no longer matches.
    const forged: MigrationPlan = { ...honest, targetSchemaHash: "f".repeat(64) };
    const { ledgerId } = await requestPlanStage(kyselyOn(app), { plan: forged, stage: "expand", requestedBy: m.adminUserId, targetVersionId: m.v1 });
    expect(await run(m.modelId)).toEqual({ ledgerId, outcome: "refused", code: "stale_plan" });
    expect(await columns(m.modelId)).toBeNull();
  });

  it("(e) a correctly hashed drop_table the target version does not imply is refused; the table stays", async () => {
    const m = await model();
    const first = await request(m, m.v1);
    expect(await run(m.modelId)).toEqual({ ledgerId: first.expandLedgerId, outcome: "succeeded" });
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

  describe("stale and unwanted requests (security re-review C)", () => {
    async function twoVersions() {
      const m = await model([field("title"), field("secret")]);
      const first = await request(m, m.v1);
      expect(await run(m.modelId)).toEqual({ ledgerId: first.expandLedgerId, outcome: "succeeded" });
      const next = async (fields: ReturnType<typeof field>[]) => {
        const current = (await getModel(m.workspaceId, m.modelId))!;
        const changed = await applyChange({ model: current, proposedSchema: { name: "Post", apiKey: m.apiKey, fields }, acknowledgeUnsafe: true, actorAdminUserId: m.adminUserId });
        if (!changed.ok || !changed.data.version) throw new Error("version not created");
        return changed.data.version.id;
      };
      return { m, next };
    }
    const statusOf = async (id: string | null) => (await backend.query<{ status: string }>("select status from schema_migration_ledger where id = $1", [id]))[0]?.status;

    it("a deletion planned against an older version cannot be confirmed once the model has a newer one", async () => {
      const { m, next } = await twoVersions();
      const v2 = await next([field("title")]);
      const dropSecret = await request(m, v2);
      expect(dropSecret.destructiveLedgerId).not.toBeNull();
      await next([field("title"), field("other")]);
      // Since Phase 4 saving the newer version queues its own change, which supersedes the waiting
      // deletion at once: it can no longer be confirmed.
      expect(await statusOf(dropSecret.destructiveLedgerId)).toBe("superseded");
      await expect(confirmPlanStage(kyselyOn(app), { ledgerId: dropSecret.destructiveLedgerId!, confirmedBy: m.adminUserId, typedApiKey: m.apiKey }))
        .rejects.toMatchObject({ code: "55000" });
      // And the database's own version check still refuses it even if the row were left waiting.
      await backend.query("update schema_migration_ledger set status = 'awaiting_confirmation' where id = $1", [dropSecret.destructiveLedgerId]);
      await expect(confirmPlanStage(kyselyOn(app), { ledgerId: dropSecret.destructiveLedgerId!, confirmedBy: m.adminUserId, typedApiKey: m.apiKey }))
        .rejects.toMatchObject({ code: "55000", message: "schema_stage_superseded" });
    });

    it("a new request supersedes the model's older requests that have not started", async () => {
      const { m, next } = await twoVersions();
      const v2 = await next([field("title"), field("body")]);
      const older = await request(m, v2);
      const v3 = await next([field("title"), field("summary")]);
      const newer = await request(m, v3);
      expect(await statusOf(older.expandLedgerId)).toBe("superseded");
      expect(await statusOf(newer.expandLedgerId)).toBe("pending");
      // Both rows of one request survive each other.
      const v4 = await next([field("title"), field("extra")]);
      const both = await request(m, v4);
      expect([await statusOf(both.expandLedgerId), await statusOf(both.destructiveLedgerId)]).toEqual(["pending", "awaiting_confirmation"]);
      expect(await statusOf(newer.expandLedgerId)).toBe("superseded");
    });

    it("cancel drops a request that has not started, and nothing else", async () => {
      const { m, next } = await twoVersions();
      const v2 = await next([field("title"), field("body")]);
      const pendingDrop = await request(m, v2);
      await expect(cancelPlanStage(kyselyOn(app), { ledgerId: pendingDrop.destructiveLedgerId!, cancelledBy: "00000000-0000-4000-8000-000000000001" }))
        .rejects.toMatchObject({ code: "22023", message: "schema_cancel_unknown_user" });
      await cancelPlanStage(kyselyOn(app), { ledgerId: pendingDrop.destructiveLedgerId!, cancelledBy: m.adminUserId });
      expect(await statusOf(pendingDrop.destructiveLedgerId)).toBe("cancelled");
      await expect(cancelPlanStage(kyselyOn(app), { ledgerId: pendingDrop.destructiveLedgerId!, cancelledBy: m.adminUserId })).rejects.toMatchObject({ code: "55000" });
      // A succeeded or running row cannot be cancelled.
      expect(await run(m.modelId)).toEqual({ ledgerId: pendingDrop.expandLedgerId, outcome: "succeeded" });
      await expect(cancelPlanStage(kyselyOn(app), { ledgerId: pendingDrop.expandLedgerId!, cancelledBy: m.adminUserId })).rejects.toMatchObject({ code: "55000" });
      const v3 = await next([field("title"), field("later")]);
      const running = await request(m, v3);
      await backend.query("update schema_migration_ledger set status = 'running' where id = $1", [running.expandLedgerId]);
      await expect(cancelPlanStage(kyselyOn(app), { ledgerId: running.expandLedgerId!, cancelledBy: m.adminUserId })).rejects.toMatchObject({ code: "55000" });
      await backend.query("update schema_migration_ledger set status = 'pending' where id = $1", [running.expandLedgerId]);
    });
  });

  it("the worker process survives losing its database session: the next poll reconnects and runs the stage", async () => {
    const m = await model([field("title")]);
    const child = spawn(process.execPath, ["--no-warnings", "--loader", "./scripts/phase12_75-node-loader.mjs", "scripts/schema-migration-worker.mjs", "--model", m.modelId], {
      cwd: process.cwd(),
      env: {
        ...process.env, NEXT_RUNTIME: "", POLYNOVEA_MIGRATION_DATABASE_URL: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, DATABASE_URL: "",
        SCHEMA_WORKER_POLL_MS: "250", POLYNOVEA_RELEASE_ID: "test-release", POLYNOVEA_SCHEMA_MAX_MODELS: "1000000",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const until = async (check: () => Promise<boolean> | boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    };
    try {
      expect(await until(() => output.includes('"event":"started"'), 30_000)).toBe(true);
      // Kill the worker's session from outside, as a failover or an operator would.
      const killed = await backend.query<{ killed: boolean }>(
        "select pg_terminate_backend(pid) as killed from pg_stat_activity where application_name = 'polynovea-schema-runner' and pid <> pg_backend_pid()",
      );
      expect(killed.some((row) => row.killed)).toBe(true);
      const queued = await request(m, m.v1);
      const done = await until(async () => {
        const [row] = await backend.query<{ status: string }>("select status from schema_migration_ledger where id = $1", [queued.expandLedgerId]);
        return row?.status === "succeeded";
      }, 45_000);
      expect(done, output).toBe(true);
      expect(output).toContain('"event":"reconnected"');
      expect(output).not.toContain("postgres://");
    } finally {
      child.kill();
    }
  });
});
