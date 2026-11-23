import { describe, expect, it } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { renderStep } from "@/lib/schema/engine/render";
import { derivedName } from "@/lib/schema/engine/names";
import type { ColumnShape, PlanStep } from "@/lib/schema/engine/plan";

const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const compile = (step: PlanStep, concurrentIndexes = false) =>
  renderStep(step, { concurrentIndexes }).map((s) => ({ ...s.sql.compile(db), transactional: s.transactional }));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const title: ColumnShape = { name: "title", field: "title", fieldType: "text", pgType: "text", requiredWhenPublished: true, unique: true, indexed: false };

describe("rendered SQL", () => {
  it("creates the table with storage columns, grants, row-level security and the app policy", () => {
    const [create, grant, rls, policy] = compile({ kind: "create_table", stage: "expand", summary: "", table: "m_post", columns: [title] });
    expect(oneLine(create.sql)).toContain('create table "content"."m_post" ( _entry_id uuid not null references public.content_entries (id) on delete cascade');
    expect(oneLine(create.sql)).toContain('_locale text not null, "title" text, primary key (_entry_id, _variant, _locale) )');
    expect(grant.sql).toBe('grant select, insert, update, delete on "content"."m_post" to "polynovea_app"');
    expect(rls.sql).toBe('alter table "content"."m_post" enable row level security');
    expect(policy.sql).toBe('create policy "polynovea_app_all" on "content"."m_post" for all to "polynovea_app" using (true) with check (true)');
  });

  it("quotes every identifier and binds the backfill value as a parameter", () => {
    const [fill] = compile({ kind: "backfill_column", stage: "expand", summary: "", table: "m_post", column: "title", pgType: "text", value: "x'); drop table users; --" });
    expect(fill.sql).toBe('update "content"."m_post" set "title" = cast($1 as text) where "title" is null');
    expect(fill.parameters).toEqual(["x'); drop table users; --"]);
    const [json] = compile({ kind: "backfill_column", stage: "expand", summary: "", table: "m_post", column: "meta", pgType: "jsonb", value: { a: 1 } });
    expect(json.parameters).toEqual(['{"a":1}']);
  });

  it("adds required as a NOT VALID check, then validates it", () => {
    const ck = derivedName("ck", "m_post", "title");
    expect(compile({ kind: "set_required", stage: "expand", summary: "", table: "m_post", column: "title" }).map((s) => s.sql)).toEqual([
      `alter table "content"."m_post" add constraint "${ck}" check (_variant <> 'published' or "title" is not null) not valid`,
      `alter table "content"."m_post" validate constraint "${ck}"`,
    ]);
  });

  it("builds indexes CONCURRENTLY outside a transaction only when the runner asks", () => {
    const step: PlanStep = { kind: "add_index", stage: "expand", summary: "", table: "m_post", column: "title", unique: true };
    const uq = derivedName("uq", "m_post", "title");
    expect(compile(step)[0]).toMatchObject({ sql: `create unique index "${uq}" on "content"."m_post" ("title", _variant, _locale)`, transactional: true });
    expect(compile(step, true)[0]).toMatchObject({ sql: `create unique index concurrently "${uq}" on "content"."m_post" ("title", _variant, _locale)`, transactional: false });
  });

  it("renames a column together with its derived index and constraint names", () => {
    const sqls = compile({ kind: "rename_column", stage: "expand", summary: "", table: "m_post", from: "title", to: "headline", field: "headline", column: title }).map((s) => s.sql);
    expect(sqls).toEqual([
      'alter table "content"."m_post" rename column "title" to "headline"',
      `alter index "content"."${derivedName("uq", "m_post", "title")}" rename to "${derivedName("uq", "m_post", "headline")}"`,
      `alter table "content"."m_post" rename constraint "${derivedName("ck", "m_post", "title")}" to "${derivedName("ck", "m_post", "headline")}"`,
    ]);
  });

  it("converts values in a lossless type change", () => {
    expect(compile({ kind: "change_type", stage: "expand", summary: "", table: "m_post", column: "meta", from: "jsonb", to: "text", fromField: "json", toField: "long_text" })[0].sql)
      .toBe(`alter table "content"."m_post" alter column "meta" type text using "meta" #>> '{}'`);
    expect(compile({ kind: "change_type", stage: "expand", summary: "", table: "m_post", column: "n", from: "bigint", to: "jsonb", fromField: "integer", toField: "json" })[0].sql)
      .toBe(`alter table "content"."m_post" alter column "n" type jsonb using to_jsonb("n")`);
  });

  it("refuses unsafe table names, identifiers, types and FK actions even from a tampered plan", () => {
    expect(() => compile({ kind: "drop_table", stage: "destructive", summary: "", table: "users" })).toThrow(/Unsafe model table name/);
    expect(() => compile({ kind: "drop_column", stage: "destructive", summary: "", table: "m_post", column: 'x" cascade; --', field: "x" })).toThrow(/Unsafe SQL identifier/);
    expect(() => compile({ kind: "add_column", stage: "expand", summary: "", table: "m_post", column: { ...title, pgType: "text; drop table x" as never } })).toThrow(/Unknown column type/);
    expect(() => compile({ kind: "add_foreign_key", stage: "expand", summary: "", table: "m_post", column: "author", onDelete: "cascade" as never })).toThrow(/Unknown foreign key action/);
  });
});

describe("rendered SQL defaults", () => {
  it("builds and drops indexes CONCURRENTLY outside a transaction unless told otherwise", () => {
    const [add] = renderStep({ kind: "add_index", stage: "expand", summary: "", table: "m_post", column: "title", unique: false });
    expect(add.transactional).toBe(false);
    expect(add.sql.compile(db).sql).toContain("create index concurrently");
    const [drop] = renderStep({ kind: "drop_index", stage: "expand", summary: "", table: "m_post", column: "title", unique: true });
    expect(drop).toMatchObject({ transactional: false, lockSensitive: false });
    expect(renderStep({ kind: "add_foreign_key", stage: "expand", summary: "", table: "m_post", column: "a", onDelete: "restrict" }).map((s) => s.transactional)).toEqual([true, true]);
  });
});
