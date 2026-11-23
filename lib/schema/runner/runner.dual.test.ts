import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeStageHash } from "@/lib/schema/engine/planner";
import { renderStep } from "@/lib/schema/engine/render";
import { derivedName } from "@/lib/schema/engine/names";
import { assertOwnerSession } from "@/lib/schema/runner/ownerPool";
import { claimNextStage, RUNNER_LOCK_CLASS, lockKey, tryLockModel, unlockModel } from "@/lib/schema/runner/ledger";
import { kyselyOn } from "@/lib/schema/runner/engine";
import { productionEngine } from "@/lib/schema/runner/engineAdapter";
import { requestPlanStage } from "@/lib/schema/runner/request";
import { column, shape } from "@/lib/schema/runner/testing/plans";
import { connect, RunnerHarness } from "@/lib/schema/runner/testing/dualFixtures";

// The migration runner against a real database: owner-only execution, the ledger, refusing tampered
// rows, NOT VALID → VALIDATE, CONCURRENTLY, and resuming after a crash at each kind of statement.

// Index builds CONCURRENTLY wait for every older transaction in the database, including the
// 30-second ones lockWait.dual.test.ts opens in parallel: give each test room for that wait.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const h = new RunnerHarness();
beforeAll(() => h.open());
afterAll(() => h.close());

describe("who can do what", () => {
  it("the worker session is polynovea_owner; the app role is refused as a runner", async () => {
    await expect(assertOwnerSession(h.session, {})).resolves.toBe("polynovea_owner");
    await expect(assertOwnerSession(h.app, {})).rejects.toMatchObject({ code: "runner_wrong_role" });
  });

  it("the app role can request a change but cannot run DDL in the content schema", async () => {
    const model = await h.newModel();
    await expect(h.app.query(`create table content.${model.table} (id int)`)).rejects.toMatchObject({ code: "42501" });
  });

  it("the app role can read but never write the runner's own tables", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const [{ id: ledgerId }] = (await h.owner.query("select id from schema_migration_ledger where content_model_id = $1", [model.modelId])).rows;
    await expect(h.app.query("select count(*) from schema_migration_runs")).resolves.toBeTruthy();
    await expect(h.app.query("select count(*) from schema_expand_contract_tasks")).resolves.toBeTruthy();
    await expect(h.app.query("update schema_migration_runs set next_step = 99 where ledger_id = $1", [ledgerId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query(
      `insert into schema_expand_contract_tasks (ledger_id, step_index, workspace_id, table_name, kind, old_column, new_column, trigger_name, status)
       values ($1, 0, $2, $3, 'rename', 'title', 'x', 'dw_x', 'awaiting_contract')`,
      [ledgerId, model.workspaceId, model.table],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("update schema_expand_contract_tasks set old_column = 'id'")).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("delete from schema_expand_contract_tasks")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the ledger", () => {
  it("records who asked, the plan hash, timings, attempts and the outcome; the run row has per-step timings", async () => {
    const model = await h.newModel();
    const columns = [column("title", "text")];
    const plan = h.plan(model, shape(model.table, columns), [{ kind: "create_table", stage: "expand", columns }]);
    const ledgerId = await h.request(model, plan);
    expect((await h.ledger(ledgerId)).status).toBe("pending");
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });

    const ledger = await h.ledger(ledgerId);
    expect(ledger).toMatchObject({ status: "succeeded", requested_by: model.adminId, plan_hash: computeStageHash(plan, "expand"), attempts: 1, error_ref: null, stage: "expand" });
    expect(ledger.started_at).toBeInstanceOf(Date);
    expect(ledger.finished_at.getTime()).toBeGreaterThanOrEqual(ledger.started_at.getTime());
    const run = await h.runRow(ledgerId);
    expect(run).toMatchObject({ status: "succeeded", worker_id: "test-worker", next_step: 1, next_statement: 0, lock_retries: 0 });
    // As many statements as the engine renders for it (the table, its grant, RLS, policy, then the entry FK NOT VALID and VALIDATE).
    expect(run.step_log).toEqual([expect.objectContaining({ step: 0, planIndex: 0, kind: "create_table", statements: renderStep(plan.steps[0]).length, lockRetries: 0 })]);
    expect(renderStep(plan.steps[0]).length).toBe(6);
    expect(Date.parse(run.step_log[0].finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.step_log[0].startedAt));

    const { rows: [table] } = await h.owner.query("select table_name, applied_shape_hash from content_model_tables where content_model_id = $1", [model.modelId]);
    expect(table).toEqual({ table_name: model.table, applied_shape_hash: plan.expandedShapeHash });
    expect(await h.columns(model)).toMatchObject({ _entry_id: "uuid", title: "text" });
  });

  it("refuses a stage built from a shape that is no longer current, and runs nothing", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const stale = h.plan({ ...model, shape: shape(model.table, [column("title", "text"), column("old", "text")]) },
      shape(model.table, [column("title", "text"), column("old", "text"), column("views", "bigint")]),
      [{ kind: "add_column", stage: "expand", column: column("views", "bigint") }]);
    const ledgerId = await h.request(model, stale);
    expect(await h.run(model)).toMatchObject({ outcome: "failed", code: "stale_plan" });
    expect(await h.columns(model)).not.toHaveProperty("views");
    expect((await h.ledger(ledgerId)).error_ref).toBe("stale_plan");
  });
});

describe("never trusting the ledger row", () => {
  it("refuses a row whose plan does not match its hash; nothing runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const plan = h.plan(model, shape(model.table, [column("title", "text"), column("views", "bigint")]),
      [{ kind: "add_column", stage: "expand", column: column("views", "bigint") }]);
    const tampered = { ...plan, steps: [{ ...plan.steps[0], column: column("hijack", "bigint") }] } as typeof plan;
    const ledgerId = await h.request(model, tampered);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "plan_hash_mismatch" });
    expect(Object.keys(await h.columns(model)).sort()).toEqual(["_entry_id", "_locale", "_variant", "title"]);
    expect(await h.ledger(ledgerId)).toMatchObject({ status: "failed", error_ref: "plan_hash_mismatch" });
    expect((await h.runRow(ledgerId)).status).toBe("refused");
  });

  it("refuses a step aimed at a public table, even with a correct hash; nothing runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const plan = h.plan(model, shape(model.table, [column("title", "text"), column("pwned", "text")]),
      [{ kind: "add_column", stage: "expand", column: column("pwned", "text"), table: "admin_users" }]);
    const ledgerId = await h.request(model, plan);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "plan_target_mismatch" });
    const { rows } = await h.owner.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name = 'pwned'");
    expect(rows).toEqual([]);

    // The whole plan pointed at a public table: refused just the same.
    const other = await h.newModel();
    const hostile = h.plan({ ...other, table: "admin_users" }, shape("admin_users", [column("pwned", "text")]), [{ kind: "add_column", stage: "expand", column: column("pwned", "text") }]);
    const hostileId = await h.request({ ...other, table: "admin_users" }, hostile);
    expect(await h.run(other)).toEqual({ ledgerId: hostileId, outcome: "refused", code: "plan_target_mismatch" });
  });

  it("refuses a forged expand row that deletes a column, even with a correct hash; nothing runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text"), column("body", "text")]);
    const after = shape(model.table, [column("title", "text")]);
    const forged = h.plan(model, after, [{ kind: "drop_column", stage: "expand", column: "body", field: "body" }]);
    const ledgerId = await h.request(model, forged);
    expect((await h.ledger(ledgerId)).status).toBe("pending");
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "plan_destructive_in_expand" });
    expect(await h.columns(model)).toHaveProperty("body");
  });
});

// The security review's attack: a stolen app login repoints content_model_tables at another
// workspace's table, inserts a correctly hashed drop_table request, and lets the owner worker drop it.
describe("security review: what a stolen app login can no longer do", () => {
  it("(a) cannot UPDATE or DELETE content_model_tables (no repointing a model at another table)", async () => {
    const [victim, attacker] = [await h.newModel(), await h.newModel()];
    await h.createTable(victim, [column("secret", "text")]);
    await h.createTable(attacker, [column("title", "text")]);
    await expect(h.app.query("update content_model_tables set table_name = $1 where content_model_id = $2", [victim.table, attacker.modelId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("update content_model_tables set applied_shape_hash = $1 where content_model_id = $2", ["0".repeat(64), attacker.modelId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("delete from content_model_tables where content_model_id = $1", [attacker.modelId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("insert into content_model_tables select * from content_model_tables where false")).rejects.toMatchObject({ code: "42501" });
    const { rows } = await h.owner.query("select table_name from content_model_tables where content_model_id = $1", [attacker.modelId]);
    expect(rows).toEqual([{ table_name: attacker.table }]);
  });

  it("(b) cannot DELETE (or write) name reservations to reuse a deleted name early", async () => {
    const model = await h.newModel();
    await h.owner.query(
      "insert into schema_name_reservations (workspace_id, content_model_id, kind, name, reason, reserved_until) values ($1, $2, 'field', 'gone', 'deleted', now() + interval '30 days')",
      [model.workspaceId, model.modelId],
    );
    await expect(h.app.query("delete from schema_name_reservations where content_model_id = $1", [model.modelId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("update schema_name_reservations set reserved_until = now() where content_model_id = $1", [model.modelId])).rejects.toMatchObject({ code: "42501" });
    const { rows } = await h.owner.query("select count(*)::int as n from schema_name_reservations where content_model_id = $1", [model.modelId]);
    expect(rows[0].n).toBe(1);
  });

  it("(c) can only insert a request: no UPDATE or DELETE of the ledger, no status of its own", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text"), column("body", "text")]);
    const plan = h.plan(model, model.shape, [{ kind: "drop_column", stage: "destructive", column: "body", field: "body" }], shape(model.table, [column("title", "text")]));
    const ledgerId = await h.request(model, plan, "destructive");
    // The trigger set the status from the stage.
    expect(await h.ledger(ledgerId)).toMatchObject({ status: "awaiting_confirmation", attempts: 0, confirmed_by: null });
    await expect(h.app.query("update schema_migration_ledger set status = 'pending' where id = $1", [ledgerId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("update schema_migration_ledger set plan_json = '{}'::jsonb where id = $1", [ledgerId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query("delete from schema_migration_ledger where id = $1", [ledgerId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query(
      `insert into schema_migration_ledger (workspace_id, content_model_id, model_api_key, table_name, stage, status, plan_hash, plan_json)
       values ($1, $2, $3, $4, 'destructive', 'pending', $5, '{}'::jsonb)`,
      [model.workspaceId, model.modelId, model.apiKey, model.table, plan.planHash],
    )).rejects.toMatchObject({ code: "42501" });
    await expect(h.app.query(
      `insert into schema_migration_ledger (workspace_id, content_model_id, model_api_key, table_name, stage, confirmed_by, plan_hash, plan_json)
       values ($1, $2, $3, $4, 'destructive', $5, $6, '{}'::jsonb)`,
      [model.workspaceId, model.modelId, model.apiKey, model.table, model.adminId, plan.planHash],
    )).rejects.toMatchObject({ code: "42501" });
    expect(await h.run(model)).toBeNull();
  });

  it("(d) a correctly hashed request whose plan targets another model's table is refused; nothing runs", async () => {
    const [victim, attacker] = [await h.newModel(), await h.newModel()];
    await h.createTable(victim, [column("secret", "text")]);
    await h.createTable(attacker, [column("title", "text")]);
    // The attacker's model, pointed at the victim's table, with a valid hash.
    const forged = h.plan({ ...attacker, table: victim.table }, shape(victim.table, [column("secret", "text"), column("x", "text")]),
      [{ kind: "add_column", stage: "expand", column: column("x", "text") }]);
    const ledgerId = await h.request({ ...attacker, table: victim.table }, forged);
    expect(await h.run(attacker)).toEqual({ ledgerId, outcome: "refused", code: "plan_target_mismatch" });
    // The victim's model, with a plan for the attacker's table: refused too.
    const reverse = h.plan({ ...victim, table: attacker.table }, shape(attacker.table, [column("title", "text"), column("y", "text")]),
      [{ kind: "add_column", stage: "expand", column: column("y", "text") }]);
    const reverseId = await h.request({ ...victim, table: attacker.table }, reverse);
    expect(await h.run(victim)).toEqual({ ledgerId: reverseId, outcome: "refused", code: "plan_target_mismatch" });
    expect(Object.keys(await h.columns(victim)).sort()).toEqual(["_entry_id", "_locale", "_variant", "secret"]);
    expect(Object.keys(await h.columns(attacker)).sort()).toEqual(["_entry_id", "_locale", "_variant", "title"]);
  });

  // (e) with the real rebuild (a correctly hashed drop_table the target version does not imply) is in
  // trustedRunner.dual.test.ts. Here: the production worker never runs a hand-built plan.
  it("the production worker refuses a hand-built request with no trusted version behind it; nothing runs", async () => {
    const model = await h.newModel();
    const columns = [column("title", "text")];
    const ledgerId = await h.request(model, h.plan(model, shape(model.table, columns), [{ kind: "create_table", stage: "expand", columns }]));
    expect(await h.run(model, { engine: productionEngine() })).toEqual({ ledgerId, outcome: "refused", code: "invalid_plan" });
    const { rows } = await h.owner.query("select to_regclass($1) as found", [`content.${model.table}`]);
    expect(rows[0].found).toBeNull();
  });

  it("(f) a destructive stage with no confirmation row never runs; the owner-side confirmation does", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text"), column("body", "text")]);
    const plan = h.plan(model, model.shape, [{ kind: "drop_column", stage: "destructive", column: "body", field: "body" }], shape(model.table, [column("title", "text")]));
    const ledgerId = await h.request(model, plan, "destructive");
    expect(await h.run(model)).toBeNull();
    // Even if the status were moved some other way, and confirmed_by filled in, there is no confirmation row.
    await h.owner.query("update schema_migration_ledger set status = 'pending', confirmed_by = $2, confirmed_at = now() where id = $1", [ledgerId, model.adminId]);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "destructive_not_confirmed" });
    expect(await h.columns(model)).toHaveProperty("body");

    // A fresh request, confirmed through the owner-side function: wrong text refused, the api key accepted.
    const again = await h.request(model, plan, "destructive");
    await expect(h.confirm(again, model.adminId, "not_the_key")).rejects.toMatchObject({ code: "22023" });
    await expect(h.app.query("insert into schema_migration_confirmations (ledger_id, workspace_id, typed_api_key) values ($1, $2, $3)", [again, model.workspaceId, model.apiKey]))
      .rejects.toMatchObject({ code: "42501" });
    await h.confirm(again, model.adminId, model.apiKey);
    await expect(h.confirm(again, model.adminId, model.apiKey)).rejects.toMatchObject({ code: "55000" });
    expect(await h.ledger(again)).toMatchObject({ status: "pending", confirmed_by: model.adminId });
    expect(await h.run(model)).toEqual({ ledgerId: again, outcome: "succeeded" });
    expect(await h.columns(model)).not.toHaveProperty("body");
  });

  it("refuses a request that names another workspace or another model's version; writes the model's own api key", async () => {
    const model = await h.newModel();
    const other = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const plan = h.plan(model, shape(model.table, [column("title", "text"), column("x", "text")]), [{ kind: "add_column", stage: "expand", column: column("x", "text") }]);
    const { rows: [otherVersion] } = await h.owner.query(
      "insert into content_model_versions (content_model_id, version_number, schema_hash, schema_json) values ($1, 1, $2, '{}'::jsonb) returning id",
      [other.modelId, "0".repeat(64)],
    );
    const { rows: [ownVersion] } = await h.owner.query(
      "insert into content_model_versions (content_model_id, version_number, schema_hash, schema_json) values ($1, 1, $2, '{}'::jsonb) returning id",
      [model.modelId, "0".repeat(64)],
    );
    // Another workspace's id with this model: refused.
    await expect(h.request(model, { ...plan, workspaceId: other.workspaceId })).rejects.toMatchObject({ code: "23514", message: "schema_request_model_mismatch" });
    // Another model's version: refused. Its own version: accepted.
    await expect(requestPlanStage(kyselyOn(h.app), { plan, stage: "expand", requestedBy: model.adminId, targetVersionId: otherVersion.id }))
      .rejects.toMatchObject({ code: "23514", message: "schema_request_version_mismatch" });
    const ok = await requestPlanStage(kyselyOn(h.app), { plan: { ...plan, modelApiKey: "forged_key" }, stage: "expand", requestedBy: model.adminId, targetVersionId: ownVersion.id });
    // The api key the app wrote is replaced by the model's own.
    expect((await h.ledger(ok.ledgerId)).model_api_key).toBe(model.apiKey);
    expect(ok.status).toBe("pending");
  });

  it("no setting the app can change gets it past the trigger: the status is always forced", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const plan = h.plan(model, model.shape, [{ kind: "drop_column", stage: "destructive", column: "title", field: "title" }], shape(model.table, []));
    await expect(h.app.query("set role polynovea_owner")).rejects.toMatchObject({ code: "42501" });
    await h.app.query("begin");
    try {
      await h.app.query("set local role polynovea_app");
      await h.app.query("set local search_path = public, pg_catalog");
      await h.app.query("set local polynovea.is_owner = 'true'");
      // Turning triggers off needs superuser: refused (the savepoint keeps the transaction usable).
      await h.app.query("savepoint try_replica");
      await expect(h.app.query("set local session_replication_role = 'replica'")).rejects.toMatchObject({ code: "42501" });
      await h.app.query("rollback to savepoint try_replica");
      const { rows: [row] } = await h.app.query(
        `insert into schema_migration_ledger (workspace_id, content_model_id, model_api_key, table_name, stage, plan_hash, plan_json)
         values ($1, $2, $3, $4, 'destructive', $5, '{}'::jsonb) returning status, attempts`,
        [model.workspaceId, model.modelId, model.apiKey, model.table, plan.planHash],
      );
      expect(row).toEqual({ status: "awaiting_confirmation", attempts: 0 });
    } finally {
      await h.app.query("rollback");
    }
  });

  it("the owner-side confirm and retry functions refuse everything but their one job", async () => {
    const model = await h.newModel();
    const other = await h.newModel();
    await h.createTable(model, [column("title", "text"), column("body", "text")]);
    // Confirming an expand stage (not destructive): not found.
    const expandId = await h.request(model, h.plan(model, shape(model.table, [column("title", "text"), column("body", "text"), column("x", "text")]),
      [{ kind: "add_column", stage: "expand", column: column("x", "text") }]));
    await expect(h.confirm(expandId, model.adminId, model.apiKey)).rejects.toMatchObject({ code: "P0002" });
    // Wrong key, including another model's key: mismatch, nothing recorded.
    const plan = h.plan(model, model.shape, [{ kind: "drop_column", stage: "destructive", column: "body", field: "body" }], shape(model.table, [column("title", "text")]));
    const destructiveId = await h.request(model, plan, "destructive");
    await expect(h.confirm(destructiveId, model.adminId, other.apiKey)).rejects.toMatchObject({ code: "22023" });
    // The confirming user must be a real, active admin user.
    await expect(h.confirm(destructiveId, "00000000-0000-4000-8000-000000000001", model.apiKey)).rejects.toMatchObject({ code: "22023", message: "schema_confirmation_unknown_user" });
    // An active admin of another workspace: refused.
    await expect(h.confirm(destructiveId, other.adminId, model.apiKey)).rejects.toMatchObject({ code: "22023", message: "schema_confirmation_unknown_user" });
    // A member of this workspace who is suspended, or whose admin account is deactivated: refused.
    const { rows: [second] } = await h.owner.query("insert into admin_users (username, email) values ($1, $1 || '@example.test') returning id", [`second-${model.apiKey}`]);
    await h.owner.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'suspended')", [model.workspaceId, second.id]);
    await expect(h.confirm(destructiveId, second.id, model.apiKey)).rejects.toMatchObject({ code: "22023", message: "schema_confirmation_unknown_user" });
    await h.owner.query("update workspace_members set status = 'active' where admin_user_id = $1", [second.id]);
    await h.owner.query("update admin_users set is_active = false where id = $1", [second.id]);
    await expect(h.confirm(destructiveId, second.id, model.apiKey)).rejects.toMatchObject({ code: "22023", message: "schema_confirmation_unknown_user" });
    expect((await h.owner.query("select count(*)::int as n from schema_migration_confirmations where ledger_id = $1", [destructiveId])).rows[0].n).toBe(0);
    // An unknown ledger id: not found. Retrying a row that did not fail (pending, succeeded): refused.
    await expect(h.confirm("00000000-0000-4000-8000-000000000000", model.adminId, model.apiKey)).rejects.toMatchObject({ code: "P0002" });
    await expect(h.retry(destructiveId)).rejects.toMatchObject({ code: "55000" });
    expect(await h.run(model)).toEqual({ ledgerId: expandId, outcome: "succeeded" });
    await expect(h.retry(expandId)).rejects.toMatchObject({ code: "55000" });
    expect((await h.ledger(expandId)).status).toBe("succeeded");
    // And no direct UPDATE of the ledger at all.
    await expect(h.app.query("update schema_migration_ledger set status = 'pending' where id = $1", [expandId])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("required fields: NOT VALID, then VALIDATE (no SET NOT NULL)", () => {
  it("adds the check without a long lock, validates it, and drafts with the field empty still save", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const [draft, published] = await h.entries(model, 3);
    await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, title) values ($1, '', 'draft', null), ($2, '', 'published', 'Hello')`, [draft, published]);
    const required = shape(model.table, [column("title", "text", { requiredWhenPublished: true })]);
    const ledgerId = await h.request(model, h.plan(model, required, [{ kind: "set_required", stage: "expand", column: "title" }]));
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });

    const { rows: [check] } = await h.owner.query("select convalidated from pg_constraint where conname = $1", [derivedName("ck", model.table, "title")]);
    expect(check).toEqual({ convalidated: true });
    const { rows: [nullable] } = await h.owner.query("select is_nullable from information_schema.columns where table_schema = 'content' and table_name = $1 and column_name = 'title'", [model.table]);
    expect(nullable.is_nullable).toBe("YES");
    const [, , third] = await h.entries(model, 3);
    await expect(h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, title) values ($1, '', 'draft', null)`, [third])).resolves.toBeTruthy();
    await expect(h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, title) values ($1, '', 'published', null)`, [third])).rejects.toMatchObject({ code: "23514" });
    expect((await h.runRow(ledgerId)).step_log[0]).toMatchObject({ kind: "set_required", statements: 2 });
  });

  it("a VALIDATE that fails keeps its place: fix the data, retry, and only the VALIDATE runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const [entry] = await h.entries(model, 1);
    await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, title) values ($1, '', 'published', null)`, [entry]);
    const required = shape(model.table, [column("title", "text", { requiredWhenPublished: true })]);
    const ledgerId = await h.request(model, h.plan(model, required, [{ kind: "set_required", stage: "expand", column: "title" }]));
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "failed", code: "check_violation" });
    expect(await h.runRow(ledgerId)).toMatchObject({ status: "failed", next_step: 0, next_statement: 1 });

    // Another stage on this model is refused while this one is half applied.
    const blocked = await h.request(model, h.plan(model, shape(model.table, [column("title", "text"), column("x", "text")]), [{ kind: "add_column", stage: "expand", column: column("x", "text") }]));
    expect(await h.run(model)).toEqual({ ledgerId: blocked, outcome: "refused", code: "model_has_unfinished_stage" });
    expect(await h.columns(model)).not.toHaveProperty("x");

    await h.owner.query(`update content.${model.table} set title = 'fixed'`);
    await h.retry(ledgerId);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect((await h.ledger(ledgerId)).attempts).toBe(2);
    expect((await h.runRow(ledgerId)).step_log).toEqual([expect.objectContaining({ kind: "set_required", statements: 2 })]);
  });
});

describe("indexes CONCURRENTLY", () => {
  it("builds outside a transaction; a failed build leaves no INVALID index, and a retry builds it", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("slug", "text")]);
    const [a, b] = await h.entries(model, 2);
    await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, slug) values ($1, '', 'draft', 'same'), ($2, '', 'draft', 'same')`, [a, b]);
    const unique = shape(model.table, [column("slug", "text", { unique: true })]);
    const ledgerId = await h.request(model, h.plan(model, unique, [{ kind: "add_index", stage: "expand", column: "slug", unique: true }]));
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "failed", code: "unique_violation" });
    expect((await h.indexes(model)).filter((index) => !index.valid)).toEqual([]);

    await h.owner.query(`update content.${model.table} set slug = 'other' where _entry_id = $1`, [b]);
    await h.retry(ledgerId);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect(await h.indexes(model)).toContainEqual({ name: derivedName("uq", model.table, "slug"), valid: true });
  });

  it("resumes after a crash between the finished build and its progress record", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("slug", "text")]);
    const indexed = shape(model.table, [column("slug", "text", { indexed: true })]);
    const ledgerId = await h.request(model, h.plan(model, indexed, [{ kind: "add_index", stage: "expand", column: "slug", unique: false }]));
    const crash = { afterNonTransactional: () => { throw new Error("simulated crash"); } };
    expect(await h.run(model, { hooks: crash })).toMatchObject({ outcome: "failed", code: "internal_error" });
    expect(await h.runRow(ledgerId)).toMatchObject({ next_step: 0, next_statement: 0 });
    await h.retry(ledgerId);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect(await h.indexes(model)).toContainEqual({ name: derivedName("ix", model.table, "slug"), valid: true });
  });
});

describe("resuming after a crash", () => {
  it("a transactional statement that crashed before COMMIT re-runs cleanly", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const next = shape(model.table, [column("title", "text"), column("views", "bigint"), column("score", "numeric")]);
    const ledgerId = await h.request(model, h.plan(model, next, [
      { kind: "add_column", stage: "expand", column: column("views", "bigint") },
      { kind: "add_column", stage: "expand", column: column("score", "numeric") },
    ]));
    const crash = { beforeCommit: ({ step }: { step: number }) => { if (step === 1) throw new Error("simulated crash"); } };
    expect(await h.run(model, { hooks: crash })).toMatchObject({ outcome: "failed" });
    expect(await h.runRow(ledgerId)).toMatchObject({ next_step: 1, next_statement: 0 });
    expect(await h.columns(model)).toHaveProperty("views");
    expect(await h.columns(model)).not.toHaveProperty("score");
    await h.retry(ledgerId);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect(await h.columns(model)).toMatchObject({ views: "bigint", score: "numeric" });
    expect((await h.runRow(ledgerId)).step_log.map((entry: { kind: string }) => entry.kind)).toEqual(["add_column", "add_column"]);
  });

  it("a worker that died mid-run is replaced: its lock is gone with its session, and the stage resumes", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const ledgerId = await h.request(model, h.plan(model, shape(model.table, [column("title", "text"), column("views", "bigint")]),
      [{ kind: "add_column", stage: "expand", column: column("views", "bigint") }]));
    const dying = await connect("owner");
    const claimed = await claimNextStage(dying, { modelId: model.modelId });
    expect(claimed?.row.id).toBe(ledgerId);
    // While the first worker lives, nobody else can take the model.
    expect(await h.run(model)).toBeNull();
    await dying.end();
    expect((await h.ledger(ledgerId)).status).toBe("running");
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect((await h.ledger(ledgerId)).attempts).toBe(2);
  });

  it("uses the two-key advisory lock form under the runner's class id", async () => {
    const model = await h.newModel();
    expect(await tryLockModel(h.session, model.modelId)).toBe(true);
    const { rows } = await h.owner.query(
      "select classid::int as classid, objid::int as objid, objsubid from pg_locks where locktype = 'advisory' and pid = $1",
      [(await h.session.query("select pg_backend_pid() as pid")).rows[0].pid],
    );
    // Two-key locks show objsubid 2; the class is RUNNER_LOCK_CLASS ("PMR3").
    expect(rows).toContainEqual({ classid: RUNNER_LOCK_CLASS, objid: lockKey(model.modelId), objsubid: 2 });
    await unlockModel(h.session, model.modelId);
  });
});
