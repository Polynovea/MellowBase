import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { connect, withPrivilegeLock } from "@/lib/schema/runner/testing/dualFixtures";

// Security re-review (A): on Supabase, migrations run as `postgres`, whose default privileges give
// service_role everything on public tables, and a deployment holds the service key (PostgREST). The
// access helper must take every write away from service_role on the tables the worker trusts, and the
// ledger trigger's exemption must be the table owner only. Recreated here on plain PostgreSQL with the
// test stack's admin login: service_role (a compatibility role) granted ALL, as Supabase does.

const PROTECTED = [
  "content_model_tables", "schema_name_reservations", "schema_migration_runs", "schema_expand_contract_tasks",
  "schema_migration_confirmations", "polynovea_migration_ledger", "schema_migration_ledger",
];

function adminUrl(): string {
  const owner = process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL;
  const password = process.env.POLYNOVEA_DEV_ADMIN_PASSWORD;
  if (!owner || !password) throw new Error("The test stack's admin login is not configured. Run node scripts/dev-db/setup.mjs");
  const url = new URL(owner);
  url.username = "polynovea_admin";
  url.password = password;
  return url.toString();
}

let admin: pg.Client;
let owner: pg.Client;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl(), ssl: false });
  await admin.connect();
  owner = await connect("owner");
  await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$");
  // What Supabase's default privileges amount to, then the helper as every later migration runs it.
  await withPrivilegeLock(admin, async () => {
    await admin.query("grant all on all tables in schema public to service_role");
    await owner.query("select public.polynovea_apply_app_access()");
  });
});
afterAll(async () => { await Promise.all([admin?.end(), owner?.end()]); });

describe("service_role (Supabase's service key) cannot write what the worker trusts", () => {
  it("has no INSERT, UPDATE, DELETE or TRUNCATE on any protected table, and cannot rewrite version history", async () => {
    for (const table of PROTECTED) {
      const { rows: [row] } = await admin.query(
        `select has_table_privilege('service_role', $1, 'insert') as i, has_table_privilege('service_role', $1, 'update') as u,
                has_table_privilege('service_role', $1, 'delete') as d, has_table_privilege('service_role', $1, 'truncate') as t`,
        [`public.${table}`],
      );
      expect({ table, ...row }).toEqual({ table, i: false, u: false, d: false, t: false });
    }
    const { rows: [versions] } = await admin.query(
      "select has_table_privilege('service_role', 'public.content_model_versions', 'update') as u, has_table_privilege('service_role', 'public.content_model_versions', 'delete') as d",
    );
    expect(versions).toEqual({ u: false, d: false });
  });

  it("is refused (42501) on every write path, as the role itself", async () => {
    await admin.query("begin");
    try {
      await admin.query("set local role service_role");
      const attempts = [
        "update public.content_model_tables set table_name = table_name where false",
        "delete from public.content_model_tables where false",
        "insert into public.schema_migration_confirmations select * from public.schema_migration_confirmations where false",
        "delete from public.schema_name_reservations where false",
        "update public.schema_migration_ledger set status = status where false",
        "insert into public.schema_migration_ledger select * from public.schema_migration_ledger where false",
        "update public.schema_migration_runs set next_step = next_step where false",
        "update public.schema_expand_contract_tasks set status = status where false",
        "update public.content_model_versions set schema_json = schema_json where false",
      ];
      for (const statement of attempts) {
        await admin.query("savepoint attempt");
        await expect(admin.query(statement), statement).rejects.toMatchObject({ code: "42501" });
        await admin.query("rollback to savepoint attempt");
      }
    } finally {
      await admin.query("rollback");
    }
  });

  it("even given INSERT and UPDATE on the ledger, a non-owner role gets its status forced (the exemption is ownership)", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const { rows: [ws] } = await owner.query("insert into workspaces (name, slug) values ($1, $1) returning id", [`sr-${suffix}`]);
    const { rows: [model] } = await owner.query("insert into content_models (workspace_id, name, api_key) values ($1, 'M', $2) returning id, api_key", [ws.id, `sr_${suffix}`]);
    await admin.query("begin");
    try {
      await admin.query("grant insert, update on public.schema_migration_ledger to service_role");
      // As on Supabase, service_role bypasses row-level security (it must see the model's row).
      await admin.query("alter role service_role bypassrls");
      await admin.query("set local role service_role");
      const { rows: [row] } = await admin.query(
        `insert into public.schema_migration_ledger (workspace_id, content_model_id, model_api_key, table_name, stage, status, attempts, plan_hash, plan_json)
         values ($1, $2, 'forged', 'm_forged', 'destructive', 'pending', 7, $3, '{}'::jsonb) returning status, attempts, model_api_key`,
        [ws.id, model.id, "0".repeat(64)],
      );
      expect(row).toEqual({ status: "awaiting_confirmation", attempts: 0, model_api_key: model.api_key });
    } finally {
      await admin.query("rollback");
    }
  });
});
