import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { RenderedStatement } from "@/lib/schema/engine/plan";
import { compile } from "@/lib/schema/runner/engine";
import { groupStatements } from "@/lib/schema/runner/execute";
import { renderStep } from "@/lib/schema/engine";

const statement = (transactional: boolean, lockSensitive: boolean): RenderedStatement => ({ sql: sql`select 1`, transactional, lockSensitive });

describe("groupStatements", () => {
  it("never puts a NOT VALID constraint and its VALIDATE in one transaction", () => {
    const statements = renderStep({ kind: "set_required", stage: "expand", summary: "", table: "m_posts", column: "title" });
    expect(groupStatements(statements)).toEqual([
      { start: 0, end: 1, transactional: true },
      { start: 1, end: 2, transactional: true },
    ]);
  });

  it("runs CONCURRENTLY statements alone, outside any transaction", () => {
    const groups = groupStatements([statement(true, true), statement(false, true), statement(false, true), statement(true, true)]);
    expect(groups).toEqual([
      { start: 0, end: 1, transactional: true },
      { start: 1, end: 2, transactional: false },
      { start: 2, end: 3, transactional: false },
      { start: 3, end: 4, transactional: true },
    ]);
  });

  it("keeps a table's create, grant, row-level security and policy in one transaction", () => {
    const statements = renderStep({ kind: "create_table", stage: "expand", summary: "", table: "m_posts", columns: [] });
    expect(groupStatements(statements)).toEqual([{ start: 0, end: 4, transactional: true }]);
  });

  it("builds indexes CONCURRENTLY by default, alone and outside a transaction", () => {
    const statements = renderStep({ kind: "add_index", stage: "expand", summary: "", table: "m_posts", column: "slug", unique: true });
    expect(groupStatements(statements)).toEqual([{ start: 0, end: 1, transactional: false }]);
  });
});

describe("compile", () => {
  it("quotes identifiers and passes values as parameters", () => {
    const compiled = compile(sql`update ${sql.id("content", "m_posts")} set ${sql.id("title")} = ${"x'); drop table y; --"}`);
    expect(compiled.text).toBe('update "content"."m_posts" set "title" = $1');
    expect(compiled.values).toEqual(["x'); drop table y; --"]);
  });
});
