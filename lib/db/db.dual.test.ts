import { afterAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import pg from "pg";
import { callFunction, closeDb, getDb, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { isClientSafeError } from "@/lib/http/clientError";

// The direct path's building blocks, against plain PostgreSQL as the runtime role.
describe("lib/db on plain PostgreSQL", () => {
  afterAll(() => closeDb());

  it("connects as polynovea_app with UTC timestamps in PostgREST's format", async () => {
    const { rows } = await sql<{ who: string; at: string; big: number }>`select current_user as who, now() as at, 9007199254740991::bigint as big`.execute(getDb());
    expect(rows[0].who).toBe("polynovea_app");
    expect(rows[0].at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/);
    expect(rows[0].big).toBe(9007199254740991);
  });

  it("the runtime role cannot run DDL", async () => {
    await expect(sql`create table polynovea_ddl_probe (id int)`.execute(getDb())).rejects.toMatchObject({ code: "42501" });
    await expect(sql`drop table taxonomies`.execute(getDb())).rejects.toMatchObject({ code: "42501" });
    await expect(sql`alter table taxonomies add column probe int`.execute(getDb())).rejects.toMatchObject({ code: "42501" });
  });

  it("withTransaction rolls back everything when the callback throws", async () => {
    const slug = `tx-${Date.now()}`;
    await expect(
      withTransaction(async (trx) => {
        await trx.insertInto("workspaces").values({ name: "Rollback probe", slug }).execute();
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const owner = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false });
    await owner.connect();
    const { rowCount } = await owner.query("select 1 from workspaces where slug = $1", [slug]);
    await owner.end();
    expect(rowCount).toBe(0);
  });

  it("callFunction surfaces a function's own exception as a safe message", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const call = callFunction("cms_merge_taxonomy_terms", {
      p_workspace_id: missing,
      p_actor_id: missing,
      p_source_term_id: missing,
      p_target_term_id: "00000000-0000-0000-0000-000000000001",
    });
    await expect(call).rejects.toBeInstanceOf(SqlFunctionError);
    const error = await call.catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/Source term .* not found/);
    expect(isClientSafeError(error)).toBe(true);
  });

  it("driver errors stay hidden from API callers", async () => {
    const error = await sql`select * from no_such_table`.execute(getDb()).catch((e: unknown) => e);
    expect(isClientSafeError(error)).toBe(false);
  });
});
