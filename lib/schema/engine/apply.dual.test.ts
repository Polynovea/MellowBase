import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { getDb } from "@/lib/db/index";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import {
  applyDestructiveStage, applyExpandStage, loadModelTable, prepareMigrationPlan, SchemaEngineError,
  type FieldRename, type MigrationPlan,
} from "@/lib/schema/engine/index";
import { ownerDb, physicalOf, physicalShape, TEST_LIMITS, uniqueKey } from "@/lib/schema/engine/testing";
import type { CanonicalSchema, FieldDefinition } from "@/lib/schema/fields/types";

const f = (key: string, type: FieldDefinition["type"] = "text", extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({ key, label: key, type, required: false, localized: false, unique: false, ...extra });

describeWithDatabase("schema engine on PostgreSQL", (backend: BackendFixtures) => {
  let owner: Kysely<DB>;
  beforeAll(() => { owner = ownerDb(); });
  afterAll(async () => { await owner.destroy(); });

  async function newModel() {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const apiKey = uniqueKey("post");
    const [row] = await backend.query<{ id: string }>("insert into content_models (workspace_id, name, api_key) values ($1, 'Post', $2) returning id", [workspaceId, apiKey]);
    const [role] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, $2, 'Editor') returning id", [workspaceId, uniqueKey("editor")]);
    let current: CanonicalSchema | null = null;
    const schema = (...fields: FieldDefinition[]): CanonicalSchema => ({ name: "Post", apiKey, fields });

    const prepare = async (target: CanonicalSchema | null, renames?: FieldRename[]): Promise<MigrationPlan> => {
      const result = await prepareMigrationPlan(getDb(), { workspaceId, model: { id: row.id, apiKey }, currentSchema: current, targetSchema: target, renames, limits: TEST_LIMITS });
      if (!result.ok) throw new Error(result.problems.map((p) => p.message).join("; "));
      return result.plan;
    };
    const apply = async (target: CanonicalSchema | null, renames?: FieldRename[]) => {
      const plan = await prepare(target, renames);
      const expand = await applyExpandStage(owner, { plan, requestedBy: adminUserId, limits: TEST_LIMITS });
      if (expand.awaitingConfirmationId) await applyDestructiveStage(owner, { ledgerId: expand.awaitingConfirmationId, confirmation: apiKey, confirmedBy: adminUserId });
      current = target;
      return plan;
    };
    const setCurrent = (schema: CanonicalSchema | null) => { current = schema; };
    const entries = async (n: number) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const [entry] = await backend.query<{ id: string }>("insert into content_entries (workspace_id, content_model_id) values ($1, $2) returning id", [workspaceId, row.id]);
        ids.push(entry.id);
      }
      return ids;
    };
    const table = async () => (await loadModelTable(getDb(), row.id))?.table ?? null;
    return { workspaceId, adminUserId, modelId: row.id, roleId: role.id, apiKey, schema, prepare, apply, setCurrent, entries, table };
  }

  const appQuery = async (text: ReturnType<typeof sql>) => text.execute(getDb());
  const errorOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  it("creates a model's table that matches its plan; the app role can write rows but never alter the table", async () => {
    const m = await newModel();
    const plan = await m.apply(m.schema(f("title", "text", { required: true, unique: true }), f("views", "integer", { index: true }), f("author", "relation", {
      relation: { targetModelApiKey: "person", cardinality: "many_to_one", onDelete: "block" },
    })));
    const table = (await m.table())!;
    expect(table).toBe(`m_${m.apiKey}`);
    expect(await physicalShape(backend.query, table)).toEqual(physicalOf(plan.targetShape));
    expect((await loadModelTable(getDb(), m.modelId))!.hash).toBe(plan.targetShapeHash);

    const [entry, other] = await m.entries(2);
    const t = sql.id("content", table);
    await appQuery(sql`insert into ${t} (_entry_id, _variant, _locale, title, author) values (${entry}, 'draft', 'en', null, ${other})`);
    await appQuery(sql`insert into ${t} (_entry_id, _variant, _locale, title) values (${entry}, 'published', 'en', 'Hello')`);
    expect(await errorOf(appQuery(sql`insert into ${t} (_entry_id, _variant, _locale, title) values (${other}, 'published', 'en', null)`))).toMatchObject({ code: "23514" });
    expect(await errorOf(appQuery(sql`insert into ${t} (_entry_id, _variant, _locale, title) values (${other}, 'published', 'en', 'Hello')`))).toMatchObject({ code: "23505" });
    expect(await errorOf(appQuery(sql`update ${t} set author = gen_random_uuid() where _entry_id = ${entry}`))).toMatchObject({ code: "23503" });
    expect(await errorOf(appQuery(sql`alter table ${t} add column sneaky text`))).toMatchObject({ code: "42501" });
    expect(await errorOf(appQuery(sql`create table content.m_sneaky (x int)`))).toMatchObject({ code: "42501" });

    const [ledger] = await backend.query("select stage, status, plan_hash, requested_by from schema_migration_ledger where content_model_id = $1", [m.modelId]);
    expect(ledger).toMatchObject({ stage: "expand", status: "succeeded", plan_hash: plan.planHash, requested_by: m.adminUserId });
  });

  it("refuses a plan built from a shape that has changed since, and a plan that was altered", async () => {
    const m = await newModel();
    const v1 = m.schema(f("title"));
    await m.apply(v1);
    const first = await m.prepare(m.schema(f("title"), f("summary")));
    const second = await m.prepare(m.schema(f("title"), f("body", "long_text")));
    await applyExpandStage(owner, { plan: first, requestedBy: null, limits: TEST_LIMITS });
    expect(await errorOf(applyExpandStage(owner, { plan: second, requestedBy: null, limits: TEST_LIMITS }))).toMatchObject({ code: "stale_plan", status: 409 });

    m.setCurrent(m.schema(f("title"), f("summary")));
    const third = await m.prepare(m.schema(f("title"), f("summary"), f("extra")));
    const tampered = { ...third, steps: third.steps.map((s) => (s.kind === "add_column" ? { ...s, column: { ...s.column, name: "other" } } : s)) };
    expect(await errorOf(applyExpandStage(owner, { plan: tampered as MigrationPlan, requestedBy: null, limits: TEST_LIMITS }))).toMatchObject({ code: "invalid_plan" });
  });

  it("holds destructive steps until the model name is typed, then deletes the field, its permissions and reserves its name in one go", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("title"), f("secret")));
    const table = (await m.table())!;
    const ids = await m.entries(3);
    for (const id of ids) await appQuery(sql`insert into ${sql.id("content", table)} (_entry_id, _variant, _locale, title, secret) values (${id}, 'draft', 'en', 't', 's')`);
    for (const field of ["title", "secret"]) {
      await backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id) values ($1, $2, $3, $4)", [m.workspaceId, m.modelId, field, m.roleId]);
    }

    const plan = await m.prepare(m.schema(f("title")));
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.steps.map((s) => s.summary)).toEqual(["Deletes the field secret: deletes 3 values"]);
    const { awaitingConfirmationId } = await applyExpandStage(owner, { plan, requestedBy: m.adminUserId, limits: TEST_LIMITS });
    expect(awaitingConfirmationId).toBeTruthy();
    expect(Object.keys((await physicalShape(backend.query, table))!)).toContain("secret");
    // The field left the schema: its permission rows went with the expand stage.
    expect((await backend.query("select field_key from content_field_permissions where content_model_id = $1", [m.modelId])).map((r) => r.field_key)).toEqual(["title"]);
    // Re-adding it before the deletion is confirmed would bring its old values back: refused.
    m.setCurrent(m.schema(f("title")));
    expect(String(await errorOf(m.prepare(m.schema(f("title"), f("secret")))))).toMatch(/waiting to be deleted; confirm or cancel that first/);

    for (const confirmation of ["", "Post", `${m.apiKey}x`]) {
      expect(await errorOf(applyDestructiveStage(owner, { ledgerId: awaitingConfirmationId!, confirmation, confirmedBy: m.adminUserId })))
        .toMatchObject({ code: "confirmation_mismatch", message: `Type the model's API key (${m.apiKey}) to confirm the deletion.` });
    }
    expect(Object.keys((await physicalShape(backend.query, table))!)).toContain("secret");

    await applyDestructiveStage(owner, { ledgerId: awaitingConfirmationId!, confirmation: m.apiKey, confirmedBy: m.adminUserId });
    m.setCurrent(m.schema(f("title")));
    expect(Object.keys((await physicalShape(backend.query, table))!)).toEqual(["title"]);
    expect((await backend.query("select field_key from content_field_permissions where content_model_id = $1", [m.modelId])).map((r) => r.field_key)).toEqual(["title"]);
    const [reservation] = await backend.query<{ name: string; days: string }>(
      "select name, round(extract(epoch from reserved_until - now()) / 86400) as days from schema_name_reservations where content_model_id = $1", [m.modelId]);
    expect(reservation).toMatchObject({ name: "secret" });
    expect(Number(reservation.days)).toBe(30);
    expect((await backend.query("select status, confirmed_by from schema_migration_ledger where id = $1", [awaitingConfirmationId]))[0])
      .toMatchObject({ status: "succeeded", confirmed_by: m.adminUserId });

    expect(await errorOf(applyDestructiveStage(owner, { ledgerId: awaitingConfirmationId!, confirmation: m.apiKey, confirmedBy: null }))).toMatchObject({ code: "stage_not_ready" });
    expect(await errorOf(m.prepare(m.schema(f("title"), f("secret"))))).toBeInstanceOf(Error);
  });

  it("rolls the permission clean-up and reservations back with the DDL when a step fails", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("keep"), f("alpha"), f("beta")));
    const table = (await m.table())!;
    const perms = async () => (await backend.query("select field_key from content_field_permissions where content_model_id = $1 order by field_key", [m.modelId])).map((r) => r.field_key);
    for (const field of ["alpha", "beta"]) {
      await backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id) values ($1, $2, $3, $4)", [m.workspaceId, m.modelId, field, m.roleId]);
    }
    const plan = await m.prepare(m.schema(f("keep"), f("gamma")));
    expect(plan.steps.map((s) => s.kind)).toEqual(["add_column", "add_search_index", "drop_column", "drop_column"]);
    // Expand fails (sabotage: the column it adds already exists): the permission clean-up rolls back too.
    await backend.query(`alter table content.${table} add column gamma text`);
    expect(await errorOf(applyExpandStage(owner, { plan, requestedBy: null, limits: TEST_LIMITS }))).toMatchObject({ code: "apply_failed" });
    expect(await perms()).toEqual(["alpha", "beta"]);
    await backend.query(`alter table content.${table} drop column gamma`);
    const { awaitingConfirmationId } = await applyExpandStage(owner, { plan, requestedBy: null, limits: TEST_LIMITS });
    expect(await perms()).toEqual([]);
    // Sabotage behind the engine's back: the second drop will fail after the first drop and its clean-up ran.
    await backend.query(`alter table content.${table} drop column beta`);

    const error = await errorOf(applyDestructiveStage(owner, { ledgerId: awaitingConfirmationId!, confirmation: m.apiKey, confirmedBy: null }));
    expect(error).toBeInstanceOf(SchemaEngineError);
    expect((error as SchemaEngineError).code).toBe("apply_failed");
    expect((error as Error).message).toMatch(/nothing was changed\. Reference: [0-9a-f-]{36}$/);
    expect(Object.keys((await physicalShape(backend.query, table))!)).toContain("alpha");
    expect(await backend.query("select 1 from schema_name_reservations where content_model_id = $1", [m.modelId])).toEqual([]);
    expect((await backend.query("select status, error_ref from schema_migration_ledger where id = $1", [awaitingConfirmationId]))[0])
      .toMatchObject({ status: "awaiting_confirmation", error_ref: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("supersedes a queued deletion when the model changes again", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("title"), f("old")));
    const drop = await m.prepare(m.schema(f("title")));
    const { awaitingConfirmationId } = await applyExpandStage(owner, { plan: drop, requestedBy: null, limits: TEST_LIMITS });
    m.setCurrent(m.schema(f("title")));
    await applyExpandStage(owner, { plan: await m.prepare(m.schema(f("title"), f("added"))), requestedBy: null, limits: TEST_LIMITS });
    expect(await errorOf(applyDestructiveStage(owner, { ledgerId: awaitingConfirmationId!, confirmation: m.apiKey, confirmedBy: null }))).toMatchObject({ code: "stage_not_ready" });
    expect(Object.keys((await physicalShape(backend.query, (await m.table())!))!).sort()).toEqual(["added", "old", "title"]);
  });

  it("renames keep the values, move the permissions and reserve the old name; renaming back is allowed", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("title", "text", { required: true, unique: true })));
    const table = (await m.table())!;
    const [id] = await m.entries(1);
    await appQuery(sql`insert into ${sql.id("content", table)} (_entry_id, _variant, _locale, title) values (${id}, 'published', 'en', 'Kept')`);
    await backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id) values ($1, $2, 'title', $3)", [m.workspaceId, m.modelId, m.roleId]);

    const plan = await m.apply(m.schema(f("headline", "text", { required: true, unique: true })), [{ from: "title", to: "headline" }]);
    expect(plan.steps.map((s) => s.summary)).toEqual(["Renames a field: title → headline (safe, two steps)"]);
    expect(await physicalShape(backend.query, table)).toEqual(physicalOf(plan.targetShape));
    expect((await backend.query(`select headline from content.${table}`))[0]).toEqual({ headline: "Kept" });
    expect((await backend.query("select field_key from content_field_permissions where content_model_id = $1", [m.modelId]))[0]).toEqual({ field_key: "headline" });
    expect(await errorOf(m.prepare(m.schema(f("headline", "text", { required: true, unique: true }), f("title"))))).toBeInstanceOf(Error);

    await m.apply(m.schema(f("title", "text", { required: true, unique: true })), [{ from: "headline", to: "title" }]);
    expect((await backend.query(`select title from content.${table}`))[0]).toEqual({ title: "Kept" });
  });

  it("counts what blocks a step, and backfills a new required field's default", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("title")));
    const table = (await m.table())!;
    const ids = await m.entries(3);
    for (const id of ids) await appQuery(sql`insert into ${sql.id("content", table)} (_entry_id, _variant, _locale, title) values (${id}, 'published', 'en', 'same')`);

    const blocked = await m.prepare(m.schema(f("title", "text", { unique: true }), f("status", "text", { required: true })));
    expect(blocked.steps.map((s) => s.summary)).toEqual([
      "Adds a field: status (text)",
      "Makes status required when published: blocked until 3 published entries have a value",
      "Makes title unique: blocked until 2 duplicate values are changed",
    ]);
    expect(await errorOf(applyExpandStage(owner, { plan: blocked, requestedBy: null, limits: TEST_LIMITS }))).toMatchObject({ code: "apply_failed" });
    expect(Object.keys((await physicalShape(backend.query, table))!)).toEqual(["title"]);

    await m.apply(m.schema(f("title"), f("status", "text", { required: true, defaultValue: "draft" })));
    expect((await backend.query(`select distinct status from content.${table}`))).toEqual([{ status: "draft" }]);
  });

  it("refuses to add fields once PostgreSQL's 1,600-column limit is used up, deleted columns included", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("title")));
    const table = (await m.table())!;
    // Behind the engine: 1,596 columns added and dropped. With _entry_id, _variant, _locale and title that is 1,600 slots.
    await backend.query(`do $$ begin for i in 1..1596 loop execute format('alter table content.%I add column filler_%s int', '${table}', i); execute format('alter table content.%I drop column filler_%s', '${table}', i); end loop; end $$`);
    const plan = await m.prepare(m.schema(f("title"), f("one_more")));
    const error = await errorOf(applyExpandStage(owner, { plan, requestedBy: null, limits: TEST_LIMITS }));
    expect(error).toMatchObject({ code: "cap_exceeded" });
    expect((error as Error).message).toMatch(/1,600 columns, which also counts deleted fields. The table needs a rebuild/);
  }, 120_000);

  it("deletes a whole model only after confirmation, with its permissions, and reserves its api key", async () => {
    const m = await newModel();
    await m.apply(m.schema(f("title")));
    const table = (await m.table())!;
    await m.entries(1);
    await backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id) values ($1, $2, 'title', $3)", [m.workspaceId, m.modelId, m.roleId]);
    const plan = await m.prepare(null);
    expect(plan.steps.map((s) => s.summary)).toEqual(["Deletes the model Post and its table: deletes 0 rows"]);
    await m.apply(null);
    expect(await physicalShape(backend.query, table)).toBeNull();
    expect(await loadModelTable(getDb(), m.modelId)).toBeNull();
    expect(await backend.query("select 1 from content_field_permissions where content_model_id = $1", [m.modelId])).toEqual([]);
    expect((await backend.query("select kind, name from schema_name_reservations where workspace_id = $1", [m.workspaceId]))).toEqual([{ kind: "model", name: m.apiKey }]);
  });

});
