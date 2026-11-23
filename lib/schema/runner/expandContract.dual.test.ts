import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { derivedName } from "@/lib/schema/engine/names";
import { contractDue } from "@/lib/schema/runner/expandContract";
import { column, shape } from "@/lib/schema/runner/testing/plans";
import { FAST_RETRY, RunnerHarness, type Model } from "@/lib/schema/runner/testing/dualFixtures";

// Renames and type changes by expand and contract: dual writes, a batched backfill that resumes from
// its last key, a switch that never loses a value, and the later contract.

// Index builds CONCURRENTLY wait for every older transaction in the database, including the
// 30-second ones lockWait.dual.test.ts opens in parallel: give each test room for that wait.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const h = new RunnerHarness();
beforeAll(() => h.open());
afterAll(() => h.close());

async function task(model: Model) {
  const { rows: [row] } = await h.owner.query("select * from schema_expand_contract_tasks where content_model_id = $1 order by created_at desc limit 1", [model.modelId]);
  return row;
}

async function triggers(model: Model): Promise<string[]> {
  const { rows } = await h.owner.query(
    "select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'content' and c.relname = $1 and not t.tgisinternal",
    [model.table],
  );
  return rows.map((row) => row.tgname);
}

describe("rename by expand and contract", () => {
  it("keeps both names in sync, resumes the backfill from its last key, carries the unique index, and contracts later", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text", { unique: true })]);
    const ids = await h.entries(model, 36);
    for (const [i, id] of ids.slice(0, 35).entries()) await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, title) values ($1, '', 'draft', $2)`, [id, `t${i}`]);

    const renamed = shape(model.table, [column("headline", "text", { unique: true })]);
    const ledgerId = await h.request(model, h.plan(model, renamed, [{ kind: "rename_column", stage: "expand", from: "title", to: "headline", field: "headline", column: model.shape!.columns.title }]));
    const hooks = {
      async afterBackfillBatch({ batch }: { batch: number }) {
        if (batch === 1) {
          // Writers that know only the old name, and writers that know only the new one, during the expand.
          await h.app.query(`update content.${model.table} set title = 'via-old' where _entry_id = $1`, [ids[0]]);
          await h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, headline) values ($1, '', 'draft', 'via-new')`, [ids[35]]);
        }
        if (batch === 2) throw new Error("simulated crash");
      },
    };
    expect(await h.run(model, { hooks, batchSize: 10 })).toMatchObject({ ledgerId, outcome: "failed" });
    const crashed = await task(model);
    expect(crashed).toMatchObject({ status: "failed", phase: "backfill", backfilled_rows: "20" });
    const { rows: [{ rest }] } = await h.owner.query(
      `select count(*)::int as rest from content.${model.table} where (_entry_id, _variant, _locale) > ($1::uuid, $2, $3)`,
      [crashed.backfill_cursor.entry_id, crashed.backfill_cursor.variant, crashed.backfill_cursor.locale],
    );

    await h.retry(ledgerId);
    expect(await h.run(model, { batchSize: 10 })).toEqual({ ledgerId, outcome: "succeeded" });
    const done = await task(model);
    // Resumed from the cursor: the first 20 rows were not touched again.
    expect(Number(done.backfilled_rows)).toBe(20 + rest);
    expect(done).toMatchObject({ status: "awaiting_contract", phase: "done", release_id: "test-release" });
    const { rows: [counts] } = await h.owner.query(
      `select count(*)::int as total, count(*) filter (where headline is distinct from title)::int as differ from content.${model.table}`,
    );
    expect(counts).toEqual({ total: 36, differ: 0 });
    expect((await h.owner.query(`select title, headline from content.${model.table} where _entry_id = $1`, [ids[35]])).rows[0]).toEqual({ title: "via-new", headline: "via-new" });
    expect(await h.indexes(model)).toContainEqual({ name: derivedName("uq", model.table, "headline"), valid: true });
    // The old column's unique index went once the new one carried it.
    expect((await h.indexes(model)).map((index) => index.name)).not.toContain(derivedName("uq", model.table, "title"));

    // After the switch, a writer of the new name keeps the old one in step until the contract.
    await h.app.query(`update content.${model.table} set headline = 'renamed' where _entry_id = $1`, [ids[1]]);
    expect((await h.owner.query(`select title from content.${model.table} where _entry_id = $1`, [ids[1]])).rows[0].title).toBe("renamed");

    const ctx = { client: h.session, retry: FAST_RETRY };
    const soon = new Date(Date.now() + 60_000);
    expect(await contractDue(ctx, { releaseId: "test-release", modelId: model.modelId, now: soon })).toBe(0);
    expect(await contractDue(ctx, { releaseId: "next-release", modelId: model.modelId, now: soon })).toBe(0);
    const later = new Date(Date.now() + 16 * 60_000);
    expect(await contractDue(ctx, { releaseId: "next-release", modelId: model.modelId, now: later })).toBe(1);
    expect(Object.keys(await h.columns(model)).sort()).toEqual(["_entry_id", "_locale", "_variant", "headline"]);
    expect(await triggers(model)).toEqual([]);
    expect(await task(model)).toMatchObject({ status: "contracted" });
  });

  it("contracts after 7 days even when no new release came", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text")]);
    await h.request(model, h.plan(model, shape(model.table, [column("name", "text")]), [{ kind: "rename_column", stage: "expand", from: "title", to: "name", field: "name", column: model.shape!.columns.title }]));
    expect(await h.run(model)).toMatchObject({ outcome: "succeeded" });
    const ctx = { client: h.session, retry: FAST_RETRY };
    expect(await contractDue(ctx, { releaseId: "test-release", modelId: model.modelId, now: new Date(Date.now() + 6 * 86_400_000) })).toBe(0);
    expect(await contractDue(ctx, { releaseId: "test-release", modelId: model.modelId, now: new Date(Date.now() + 7 * 86_400_000 + 60_000) })).toBe(1);
  });
});

describe("type change by expand and contract", () => {
  async function amountModel(rows: number) {
    const model = await h.newModel();
    await h.createTable(model, [column("amount", "text", { requiredWhenPublished: true, indexed: true })]);
    const ids = await h.entries(model, rows + 2);
    for (const [i, id] of ids.slice(0, rows).entries()) await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, amount) values ($1, '', 'published', $2)`, [id, String(i * 10)]);
    const numeric = shape(model.table, [column("amount", "numeric", { requiredWhenPublished: true, indexed: true })]);
    const plan = h.plan(model, numeric, [{ kind: "change_type", stage: "expand", column: "amount", from: "text", to: "numeric", fromField: "text", toField: "number" }]);
    return { model, ids, plan };
  }

  it("a value that cannot convert never fails the save; the stage stops before the switch with the old data intact", async () => {
    const { model, ids, plan } = await amountModel(12);
    const ledgerId = await h.request(model, plan);
    const hooks = {
      async afterBackfillBatch({ batch }: { batch: number }) {
        if (batch === 1) await h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, amount) values ($1, '', 'published', 'abc')`, [ids[12]]);
      },
    };
    expect(await h.run(model, { hooks, batchSize: 5 })).toEqual({ ledgerId, outcome: "failed", code: "type_conversion_failed" });
    expect((await h.columns(model)).amount).toBe("text");
    const { rows } = await h.owner.query(`select amount from content.${model.table} order by amount`);
    expect(rows.map((row) => row.amount)).toContain("abc");
    expect(rows).toHaveLength(13);
    expect(await task(model)).toMatchObject({ status: "failed", phase: "precheck", error_ref: "type_conversion_failed" });

    // Fix the value and retry: resumes at the check, switches, and the column is numeric.
    await h.app.query(`update content.${model.table} set amount = '42' where _entry_id = $1`, [ids[12]]);
    await h.retry(ledgerId);
    expect(await h.run(model, { batchSize: 5 })).toEqual({ ledgerId, outcome: "succeeded" });
    const columns = await h.columns(model);
    expect(columns.amount).toBe("numeric");
    const retired = (await task(model)).retired_column;
    expect(columns[retired]).toBe("text");
    const { rows: values } = await h.owner.query(`select amount from content.${model.table} order by amount`);
    expect(values.map((row) => Number(row.amount))).toEqual([0, 10, 20, 30, 40, 42, 50, 60, 70, 80, 90, 100, 110]);
    // The new column took over the old one's index and check names; no trigger is left.
    expect(await h.indexes(model)).toContainEqual({ name: derivedName("ix", model.table, "amount"), valid: true });
    const { rows: [check] } = await h.owner.query("select convalidated, pg_get_constraintdef(oid) as def from pg_constraint where conname = $1", [derivedName("ck", model.table, "amount")]);
    expect(check.convalidated).toBe(true);
    expect(check.def).toMatch(/amount IS NOT NULL/);
    expect(await triggers(model)).toEqual([]);
    await expect(h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, amount) values ($1, '', 'published', null)`, [ids[13]])).rejects.toMatchObject({ code: "23514" });
    await expect(h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, amount) values ($1, '', 'draft', null)`, [ids[13]])).resolves.toBeTruthy();

    // Contract drops the retired column.
    expect(await contractDue({ client: h.session, retry: FAST_RETRY }, { releaseId: "x", modelId: model.modelId, dueOnly: false })).toBe(1);
    expect(await h.columns(model)).not.toHaveProperty(retired);
  });

  it("the switch re-checks inside its own transaction: a bad value written after the check stops it cleanly", async () => {
    const { model, ids, plan } = await amountModel(4);
    const ledgerId = await h.request(model, plan);
    let concurrentStatements = 0;
    const hooks = {
      async afterNonTransactional() {
        // 1st: the guard index; 2nd: the new column's index, after the pre-check passed.
        concurrentStatements += 1;
        if (concurrentStatements === 2) {
          await h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, amount) values ($1, '', 'published', 'twelve')`, [ids[4]]);
        }
      },
    };
    expect(await h.run(model, { hooks })).toEqual({ ledgerId, outcome: "failed", code: "type_conversion_failed" });
    expect(concurrentStatements).toBe(2);
    expect((await h.columns(model)).amount).toBe("text");
    expect((await h.owner.query(`select amount from content.${model.table} where _entry_id = $1`, [ids[4]])).rows[0].amount).toBe("twelve");
    expect(await task(model)).toMatchObject({ status: "failed", phase: "switch" });

    await h.app.query(`update content.${model.table} set amount = '12' where _entry_id = $1`, [ids[4]]);
    await h.retry(ledgerId);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect((await h.columns(model)).amount).toBe("numeric");
  });
});

describe("later steps on the renamed or retyped column", () => {
  async function appliedHash(model: Model): Promise<string> {
    const { rows: [row] } = await h.owner.query("select applied_shape_hash from content_model_tables where content_model_id = $1", [model.modelId]);
    return row.applied_shape_hash;
  }

  it("a rename followed by making the new name required: runs once, ends at the plan's expanded shape", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("title", "text", { indexed: true })]);
    const ids = await h.entries(model, 3);
    await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, title) values ($1, '', 'published', 'a'), ($2, '', 'draft', null)`, [ids[0], ids[1]]);
    const expanded = shape(model.table, [column("headline", "text", { indexed: true, requiredWhenPublished: true })]);
    const plan = h.plan(model, expanded, [
      { kind: "rename_column", stage: "expand", from: "title", to: "headline", field: "headline", column: model.shape!.columns.title },
      { kind: "set_required", stage: "expand", column: "headline" },
    ]);
    const ledgerId = await h.request(model, plan);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect(await appliedHash(model)).toBe(plan.expandedShapeHash);
    expect((await h.runRow(ledgerId)).step_log.map((entry: { kind: string }) => entry.kind)).toEqual(["rename_column", "set_required"]);
    const { rows: [check] } = await h.owner.query("select convalidated from pg_constraint where conname = $1", [derivedName("ck", model.table, "headline")]);
    expect(check).toEqual({ convalidated: true });
    expect(await h.indexes(model)).toContainEqual({ name: derivedName("ix", model.table, "headline"), valid: true });
    await expect(h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, headline) values ($1, '', 'published', null)`, [ids[2]])).rejects.toMatchObject({ code: "23514" });
    await expect(h.app.query(`insert into content.${model.table} (_entry_id, _locale, _variant, headline) values ($1, '', 'draft', null)`, [ids[2]])).resolves.toBeTruthy();
  });

  it("a type change followed by a unique index on the column: runs once, ends at the plan's expanded shape", async () => {
    const model = await h.newModel();
    await h.createTable(model, [column("amount", "bigint")]);
    const ids = await h.entries(model, 4);
    for (const [i, id] of ids.entries()) await h.owner.query(`insert into content.${model.table} (_entry_id, _locale, _variant, amount) values ($1, '', 'draft', $2)`, [id, i]);
    const expanded = shape(model.table, [column("amount", "numeric", { unique: true })]);
    const plan = h.plan(model, expanded, [
      { kind: "change_type", stage: "expand", column: "amount", from: "bigint", to: "numeric", fromField: "integer", toField: "number" },
      { kind: "add_index", stage: "expand", column: "amount", unique: true },
    ]);
    const ledgerId = await h.request(model, plan);
    expect(await h.run(model)).toEqual({ ledgerId, outcome: "succeeded" });
    expect(await appliedHash(model)).toBe(plan.expandedShapeHash);
    expect((await h.columns(model)).amount).toBe("numeric");
    expect(await h.indexes(model)).toContainEqual({ name: derivedName("uq", model.table, "amount"), valid: true });
    const { rows } = await h.owner.query(`select amount from content.${model.table} order by amount`);
    expect(rows.map((row) => Number(row.amount))).toEqual([0, 1, 2, 3]);
  });
});
