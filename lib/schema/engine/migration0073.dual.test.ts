// Migration 0073's guard: never adopt an existing "content" schema that is not ours. The guard block is
// run against a throwaway schema name (inside a rolled-back transaction), so the real schema is untouched.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";

const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0073_schema_engine.sql"), "utf8").replace(/\r\n/g, "\n");
const guard = migration.match(/-- schema-guard:start\n([\s\S]*?)-- schema-guard:end/)?.[1];

describeWithDatabase("migration 0073: existing content schema guard", (backend) => {
  async function runGuard(prepare: (schema: string) => string[]): Promise<{ error: string | null; exists: boolean }> {
    expect(guard, "0073 must mark its guard with -- schema-guard:start / -- schema-guard:end").toBeTruthy();
    const schema = `content_guard_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const block = guard!.replace(/'content'/g, `'${schema}'`).replace(/create schema content;/g, `create schema ${schema};`);
    await backend.query("begin");
    try {
      for (const statement of prepare(schema)) await backend.query(statement);
      let error: string | null = null;
      await backend.query("savepoint guard");
      try {
        await backend.query(block);
      } catch (caught) {
        error = (caught as Error).message;
        await backend.query("rollback to savepoint guard");
      }
      const [row] = await backend.query<{ exists: boolean }>("select exists (select 1 from pg_namespace where nspname = $1) as exists", [schema]);
      return { error, exists: row.exists };
    } finally {
      await backend.query("rollback");
    }
  }

  it("creates the schema when there is none", async () => {
    expect(await runGuard(() => [])).toEqual({ error: null, exists: true });
  });

  it("accepts an existing schema that is ours and empty, or holds only model tables", async () => {
    expect(await runGuard((s) => [`create schema ${s}`])).toEqual({ error: null, exists: true });
    expect(await runGuard((s) => [`create schema ${s}`, `create table ${s}.m_post (x int)`])).toEqual({ error: null, exists: true });
  });

  it("refuses an existing schema holding anything Polynovea did not create", async () => {
    for (const extra of ["create table %s.customer_data (x int)", "create view %s.v as select 1 as x", "create function %s.f() returns int language sql as 'select 1'", "create type %s.mood as enum ('a')"]) {
      const result = await runGuard((s) => [`create schema ${s}`, extra.replace("%s", s)]);
      expect(result.error, extra).toMatch(/holds objects Polynovea CMS did not create/);
    }
  });
});
