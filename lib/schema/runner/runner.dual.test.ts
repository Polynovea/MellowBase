import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { derivedName } from "@/lib/schema/engine/names";
import { assertOwnerSession } from "@/lib/schema/runner/ownerPool";
import { claimNextStage, RUNNER_LOCK_CLASS, lockKey, tryLockModel, unlockModel } from "@/lib/schema/runner/ledger";
import { column, shape } from "@/lib/schema/runner/testing/plans";
import { connect, RunnerHarness } from "@/lib/schema/runner/testing/dualFixtures";

// The migration runner against a real database: owner-only execution, the ledger, refusing tampered
// rows, NOT VALID → VALIDATE, CONCURRENTLY, and resuming after a crash at each kind of statement.

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
    expect(ledger).toMatchObject({ status: "succeeded", requested_by: model.adminId, plan_hash: plan.planHash, attempts: 1, error_ref: null, stage: "expand" });
    expect(ledger.started_at).toBeInstanceOf(Date);
    expect(ledger.finished_at.getTime()).toBeGreaterThanOrEqual(ledger.started_at.getTime());
    const run = await h.runRow(ledgerId);
    expect(run).toMatchObject({ status: "succeeded", worker_id: "test-worker", next_step: 1, next_statement: 0, lock_retries: 0 });
    expect(run.step_log).toEqual([expect.objectContaining({ step: 0, planIndex: 0, kind: "create_table", statements: 4, lockRetries: 0 })]);
    expect(Date.parse(run.step_log[0].finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.step_log[0].startedAt));

    const { rows: [table] } = await h.owner.query("select table_name, applied_shape_hash from content_model_tables where content_model_id = $1", [model.modelId]);
    expect(table).toEqual({ table_name: model.table, applied_shape_hash: plan.expandedShapeHash });
    expect(await h.columns(model)).toMatchObject({ entry_id: "uuid", title: "text" });
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
  it("(a) refuses a row whose plan was changed after it was hashed; nothing runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const plan = h.plan(model, shape(model.table, [column("title", "text"), column("views", "bigint")]),
      [{ kind: "add_column", stage: "expand", column: column("views", "bigint") }]);
    const ledgerId = await h.request(model, plan);
    await h.app.query(
      `update schema_migration_ledger set plan_json = jsonb_set(plan_json, '{steps,0,column,name}', '"hijack"') where id = $1`,
      [ledgerId],
    );
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "plan_hash_mismatch" });
    expect(Object.keys(await h.columns(model)).sort()).toEqual(["entry_id", "locale", "title", "variant"]);
    expect(await h.ledger(ledgerId)).toMatchObject({ status: "failed", error_ref: "plan_hash_mismatch" });
    expect((await h.runRow(ledgerId)).status).toBe("refused");
  });

  it("(b) refuses a step aimed at a public table, even with a correct hash; nothing runs", async () => {
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

  it("(c) refuses a destructive stage switched to pending without confirmation; nothing runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text"), column("body", "text")]);
    const after = shape(model.table, [column("title", "text")]);
    const plan = h.plan(model, model.shape, [{ kind: "drop_column", stage: "destructive", column: "body" }], after);
    const ledgerId = await h.request(model, plan, "destructive");
    expect((await h.ledger(ledgerId)).status).toBe("awaiting_confirmation");
    expect(await h.run(model)).toBeNull();
    await h.app.query("update schema_migration_ledger set status = 'pending' where id = $1", [ledgerId]);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "destructive_not_confirmed" });
    expect(await h.columns(model)).toHaveProperty("body");

    // Confirmed properly, it runs.
    await h.app.query("update schema_migration_ledger set status = 'pending', confirmed_by = $2, confirmed_at = now() where id = $1", [ledgerId, model.adminId]);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect(await h.columns(model)).not.toHaveProperty("body");
  });
});

describe("never trusting the ledger row: data-deleting steps", () => {
  it("(d) refuses a forged expand row that deletes a column, even with a correct hash; nothing runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text"), column("body", "text")]);
    const after = shape(model.table, [column("title", "text")]);
    const forged = h.plan(model, after, [{ kind: "drop_column", stage: "expand", column: "body" }]);
    const ledgerId = await h.request(model, forged);
    expect((await h.ledger(ledgerId)).status).toBe("pending");
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "refused", code: "plan_destructive_in_expand" });
    expect(await h.columns(model)).toHaveProperty("body");
  });
});

describe("required fields: NOT VALID, then VALIDATE (no SET NOT NULL)", () => {
  it("adds the check without a long lock, validates it, and drafts with the field empty still save", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const [draft, published] = await h.entries(model, 3);
    await h.owner.query(`insert into content.${model.table} (entry_id, locale, variant, title) values ($1, '', 'draft', null), ($2, '', 'published', 'Hello')`, [draft, published]);
    const required = shape(model.table, [column("title", "text", { requiredWhenPublished: true })]);
    const ledgerId = await h.request(model, h.plan(model, required, [{ kind: "set_required", stage: "expand", column: "title" }]));
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });

    const { rows: [check] } = await h.owner.query("select convalidated from pg_constraint where conname = $1", [derivedName("ck", model.table, "title")]);
    expect(check).toEqual({ convalidated: true });
    const { rows: [nullable] } = await h.owner.query("select is_nullable from information_schema.columns where table_schema = 'content' and table_name = $1 and column_name = 'title'", [model.table]);
    expect(nullable.is_nullable).toBe("YES");
    const [, , third] = await h.entries(model, 3);
    await expect(h.app.query(`insert into content.${model.table} (entry_id, locale, variant, title) values ($1, '', 'draft', null)`, [third])).resolves.toBeTruthy();
    await expect(h.app.query(`insert into content.${model.table} (entry_id, locale, variant, title) values ($1, '', 'published', null)`, [third])).rejects.toMatchObject({ code: "23514" });
    expect((await h.runRow(ledgerId)).step_log[0]).toMatchObject({ kind: "set_required", statements: 2 });
  });

  it("a VALIDATE that fails keeps its place: fix the data, retry, and only the VALIDATE runs", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    const [entry] = await h.entries(model, 1);
    await h.owner.query(`insert into content.${model.table} (entry_id, locale, variant, title) values ($1, '', 'published', null)`, [entry]);
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
    await h.owner.query(`insert into content.${model.table} (entry_id, locale, variant, slug) values ($1, '', 'draft', 'same'), ($2, '', 'draft', 'same')`, [a, b]);
    const unique = shape(model.table, [column("slug", "text", { unique: true })]);
    const ledgerId = await h.request(model, h.plan(model, unique, [{ kind: "add_index", stage: "expand", column: "slug", unique: true }]));
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "failed", code: "unique_violation" });
    expect((await h.indexes(model)).filter((index) => !index.valid)).toEqual([]);

    await h.owner.query(`update content.${model.table} set slug = 'other' where entry_id = $1`, [b]);
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
