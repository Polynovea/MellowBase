import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { connect, withPrivilegeLock } from "@/lib/schema/runner/testing/dualFixtures";

// Migration 0074's access rule: the tables the migration worker and the engine's bookkeeping act on
// are read-only for the app role, and stay so when the access helper runs again (every later
// migration calls it). installation keeps its 0072 rule, and the request tables stay writable.

const READ_ONLY = [
  "polynovea_migration_ledger", "schema_migration_runs", "schema_expand_contract_tasks", "content_model_tables", "schema_name_reservations",
  "schema_migration_confirmations",
];
/** The only ledger columns the app may set when it requests a change. */
const LEDGER_REQUEST_COLUMNS = [
  "base_shape_hash", "content_model_id", "model_api_key", "plan_hash", "plan_json", "renames", "requested_by", "stage", "table_name",
  "target_schema_hash", "target_version_id", "workspace_id",
];

let owner: pg.Client;
let app: pg.Client;
beforeAll(async () => { [owner, app] = await Promise.all([connect("owner"), connect("app")]); });
afterAll(async () => { await Promise.all([owner?.end(), app?.end()]); });

async function privileges(table: string) {
  const { rows: [row] } = await owner.query(
    `select has_table_privilege('polynovea_app', $1, 'select') as s, has_table_privilege('polynovea_app', $1, 'insert') as i,
            has_table_privilege('polynovea_app', $1, 'update') as u, has_table_privilege('polynovea_app', $1, 'delete') as d,
            has_table_privilege('polynovea_app', $1, 'truncate') as t`,
    [`public.${table}`],
  );
  return row;
}

describe("0074: read-only tables for the app role", () => {
  for (const pass of ["after the migrations", "after the helper runs again"]) {
    it(`each listed table is SELECT only ${pass}; installation is SELECT and INSERT; requests stay writable`, async () => {
      if (pass !== "after the migrations") await withPrivilegeLock(owner, () => owner.query("select public.polynovea_apply_app_access()"));
      for (const table of READ_ONLY) expect({ table, ...(await privileges(table)) }).toEqual({ table, s: true, i: false, u: false, d: false, t: false });
      expect(await privileges("installation")).toEqual({ s: true, i: true, u: false, d: false, t: false });
      expect(await privileges("content_model_versions")).toEqual({ s: true, i: true, u: false, d: false, t: false });
      // The ledger: read, and insert the request columns only; never update or delete.
      expect(await privileges("schema_migration_ledger")).toEqual({ s: true, i: false, u: false, d: false, t: false });
      const { rows: insertable } = await owner.query(
        `select column_name from information_schema.columns c
          where table_schema = 'public' and table_name = 'schema_migration_ledger'
            and has_column_privilege('polynovea_app', 'public.schema_migration_ledger', c.column_name, 'INSERT') order by 1`,
      );
      expect(insertable.map((row) => row.column_name)).toEqual(LEDGER_REQUEST_COLUMNS);
      const { rows: [updatable] } = await owner.query("select has_any_column_privilege('polynovea_app', 'public.schema_migration_ledger', 'UPDATE') as u");
      expect(updatable.u).toBe(false);
      expect(await privileges("content_field_permissions")).toMatchObject({ s: true, i: true, u: true, d: true });
    });
  }

  it("the app role is refused when it actually tries to write them", async () => {
    for (const table of READ_ONLY) {
      await expect(app.query(`delete from public.${table} where false`)).rejects.toMatchObject({ code: "42501" });
      const { rows: [first] } = await owner.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position limit 1", [table]);
      await expect(app.query(`update public.${table} set "${first.column_name}" = "${first.column_name}" where false`)).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(`insert into public.${table} select * from public.${table} where false`)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("the confirm and retry functions run as the owner, with an empty search_path, for the app role only", async () => {
    const { rows } = await owner.query(
      `select p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner,
              has_function_privilege('polynovea_app', p.oid, 'execute') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('polynovea_confirm_schema_stage', 'polynovea_retry_schema_stage', 'polynovea_cancel_schema_stage') order by 1`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ prosecdef: true, owner: "polynovea_owner", app: true, public_exec: false });
      expect(row.proconfig).toContain('search_path=""');
    }
  });

  it("records the runtime version without ever moving it backwards", async () => {
    const { rows: [state] } = await owner.query("select schema_migration from cms_runtime_state where singleton = true");
    expect(state.schema_migration >= "0074").toBe(true);
  });
});
