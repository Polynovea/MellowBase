import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetModeForTests, resolveMode } from "@/lib/setup/mode";

// Migration 0072 (installation row) on plain PostgreSQL, as the roles themselves. Setup locks for good
// on this row, so the app role must be able to insert it once and never change or delete it.

async function connect(url: string | undefined): Promise<pg.Client> {
  if (!url) throw new Error("Test database URL missing; run node scripts/dev-db/setup.mjs");
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  return client;
}

const errorCode = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) => error.code ?? "unknown");

describe("installation row (migration 0072)", () => {
  let owner: pg.Client;
  let app: pg.Client;
  let app2: pg.Client;
  let adminId: string;

  beforeAll(async () => {
    owner = await connect(process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL);
    app = await connect(process.env.POLYNOVEA_TEST_POSTGRES_URL);
    app2 = await connect(process.env.POLYNOVEA_TEST_POSTGRES_URL);
    const suffix = randomUUID().slice(0, 8);
    const { rows } = await owner.query<{ id: string }>(
      "insert into admin_users (username, email, role) values ($1, $2, 'master') returning id",
      [`install-${suffix}`, `install-${suffix}@example.test`],
    );
    adminId = rows[0].id;
  });

  afterEach(async () => {
    // Only the owner role can remove the row; tests start from an uninstalled database.
    await owner.query("delete from installation");
  });

  afterAll(async () => {
    await owner?.query("delete from installation").catch(() => {});
    await owner?.query("delete from admin_users where id = $1", [adminId]).catch(() => {});
    await Promise.all([owner?.end(), app?.end(), app2?.end()]);
  });

  const insert = (client: pg.Client, organisation: string) =>
    client.query("insert into installation (organisation_name, owner_admin_user_id, database_mode, app_version) values ($1, $2, 'managed', 'test')", [organisation, adminId]);

  it("the app role inserts the row once; defaults fill the rest", async () => {
    await insert(app, "Example Org");
    const { rows } = await app.query("select singleton, install_id, organisation_name, owner_admin_user_id, database_mode, completed_at from installation");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ singleton: true, organisation_name: "Example Org", owner_admin_user_id: adminId, database_mode: "managed" });
    expect(rows[0].install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await errorCode(insert(app, "Second"))).toBe("23505");
  });

  it("two setups finishing at once leave exactly one row", async () => {
    await app.query("begin");
    await app2.query("begin");
    await insert(app, "First browser");
    // The second insert waits on the first transaction's key, then fails when it commits.
    const second = errorCode(insert(app2, "Second browser"));
    await app.query("commit");
    expect(await second).toBe("23505");
    await app2.query("rollback");
    const { rows } = await owner.query("select organisation_name from installation");
    expect(rows).toEqual([{ organisation_name: "First browser" }]);
  });

  it("the app role cannot update, delete or truncate it, so a stolen app login cannot reopen setup", async () => {
    await insert(app, "Locked Org");
    expect(await errorCode(app.query("update installation set organisation_name = 'Taken'"))).toBe("42501");
    expect(await errorCode(app.query("delete from installation"))).toBe("42501");
    expect(await errorCode(app.query("truncate installation"))).toBe("42501");
    expect(await errorCode(app.query("alter table installation disable row level security"))).toBe("42501");
    const { rows } = await owner.query("select organisation_name from installation");
    expect(rows).toEqual([{ organisation_name: "Locked Org" }]);
  });

  it("allows only one row, a known database mode and a real owner", async () => {
    expect(await errorCode(app.query("insert into installation (singleton, organisation_name, database_mode) values (false, 'x', 'local')"))).toBe("23514");
    expect(await errorCode(app.query("insert into installation (organisation_name, database_mode) values ('x', 'cloud')"))).toBe("23514");
    expect(await errorCode(app.query("insert into installation (organisation_name, database_mode) values ('  ', 'local')"))).toBe("23514");
    expect(await errorCode(app.query("insert into installation (organisation_name, owner_admin_user_id, database_mode) values ('x', $1, 'local')", [randomUUID()]))).toBe("23503");
  });

  it("has row-level security with the app-role policy, and the access helper keeps the restriction", async () => {
    const check = async () => {
      const { rows } = await owner.query(`
        select c.relrowsecurity as rls,
          exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'installation'
                  and p.cmd = 'ALL' and 'polynovea_app' = any(p.roles) and p.qual = 'true' and p.with_check = 'true') as policy,
          has_table_privilege('polynovea_app', c.oid, 'select') as can_select,
          has_table_privilege('polynovea_app', c.oid, 'insert') as can_insert,
          has_table_privilege('polynovea_app', c.oid, 'update') as can_update,
          has_table_privilege('polynovea_app', c.oid, 'delete') as can_delete,
          has_table_privilege('polynovea_app', c.oid, 'truncate') as can_truncate
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'installation'`);
      return rows[0];
    };
    const expected = { rls: true, policy: true, can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false };
    expect(await check()).toEqual(expected);
    // Later migrations end with this call; it must not hand UPDATE or DELETE back.
    await owner.query("select public.polynovea_apply_app_access()");
    expect(await check()).toEqual(expected);
  });
});

// Migration 0072's backfill, run exactly as written but against copies of the tables in a throwaway
// schema inside a rolled-back transaction, so each case starts from a known database and parallel test
// files cannot affect it.
const migration = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0072_installation.sql"), "utf8");
const backfill = migration.slice(migration.indexOf("-- backfill:start"), migration.indexOf("-- backfill:end")).replace(/public\./g, "backfill_probe.");

describe("0072 backfill: setup never opens on a database that holds an install", () => {
  let owner: pg.Client;
  beforeAll(async () => { owner = await connect(process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL); });
  afterAll(async () => { await owner?.end(); });

  type Seed = (q: (text: string, values?: unknown[]) => Promise<pg.QueryResult>) => Promise<void>;
  async function runBackfill(seed: Seed) {
    await owner.query("begin");
    try {
      await owner.query("create schema backfill_probe");
      for (const table of ["admin_users", "workspace_members", "content_entries", "workspaces", "installation"]) {
        await owner.query(`create table backfill_probe.${table} (like public.${table} including all)`);
      }
      // What migration 0007 leaves on every fresh database.
      await owner.query("insert into backfill_probe.workspaces (name, slug) values ('Polynovea', 'polynovea')");
      await seed((text, values) => owner.query(text, values));
      await owner.query(backfill);
      const { rows } = await owner.query("select organisation_name, owner_admin_user_id, database_mode from backfill_probe.installation");
      return rows;
    } finally {
      await owner.query("rollback");
    }
  }
  const admin = (role: string, active = true, created = "2025-01-01") =>
    async (q: Parameters<Seed>[0]) => (await q("insert into backfill_probe.admin_users (username, email, role, is_active, created_at) values ($1, $2, $3, $4, $5) returning id", [`u-${randomUUID().slice(0, 8)}`, `${randomUUID().slice(0, 8)}@example.test`, role, active, created])).rows[0].id as string;

  it("a fresh database (only the seeded workspace) gets no row, so setup runs", async () => {
    expect(backfill).toContain("insert into backfill_probe.installation");
    expect(backfill).not.toContain("public.");
    expect(await runBackfill(async () => {})).toEqual([]);
  });

  it("only an editor: row, no owner", async () => {
    expect(await runBackfill(async (q) => { await admin("editor")(q); })).toEqual([{ organisation_name: "Polynovea", owner_admin_user_id: null, database_mode: "managed" }]);
  });

  it("only an admin-role user: row, that admin is the owner", async () => {
    let id = "";
    const rows = await runBackfill(async (q) => { id = await admin("admin")(q); });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_admin_user_id).toBe(id);
  });

  it("a deactivated master: row; the owner is an active admin if there is one, else none", async () => {
    expect((await runBackfill(async (q) => { await admin("master", false)(q); }))[0]).toMatchObject({ owner_admin_user_id: null });
    let adminId = "";
    const rows = await runBackfill(async (q) => { await admin("master", false, "2024-01-01")(q); adminId = await admin("admin", true, "2025-06-01")(q); });
    expect(rows[0].owner_admin_user_id).toBe(adminId);
  });

  it("an active master wins over an older admin", async () => {
    let masterId = "";
    const rows = await runBackfill(async (q) => { await admin("admin", true, "2023-01-01")(q); masterId = await admin("master", true, "2025-01-01")(q); });
    expect(rows[0].owner_admin_user_id).toBe(masterId);
  });

  it("content, members or another workspace without users still count as an install", async () => {
    const workspace = async (q: Parameters<Seed>[0]) => (await q("insert into backfill_probe.workspaces (name, slug) values ('Acme', 'acme') returning id")).rows[0].id as string;
    expect(await runBackfill(async (q) => { await workspace(q); })).toEqual([{ organisation_name: "Acme", owner_admin_user_id: null, database_mode: "managed" }]);
    expect(await runBackfill(async (q) => {
      const { rows } = await q("select id from backfill_probe.workspaces where slug = 'polynovea'");
      await q("insert into backfill_probe.content_entries (workspace_id, content_model_id) values ($1, $2)", [rows[0].id, randomUUID()]);
    })).toHaveLength(1);
  });
});

describe("start-up mode on the test database (users exist)", () => {
  let owner: pg.Client;
  beforeAll(async () => { owner = await connect(process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL); });
  afterAll(async () => {
    await owner?.query("delete from installation").catch(() => {});
    await owner?.end();
    resetModeForTests();
  });

  it("without the installation row the CMS is unavailable, never in setup; with it, running", async () => {
    const env = { POLYNOVEA_DATABASE_URL: process.env.POLYNOVEA_TEST_POSTGRES_URL, POLYNOVEA_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "polynovea-mode-dual-")) };
    await owner.query("delete from installation");
    // Other test files create admin users and workspaces; make sure at least one exists here.
    await owner.query("insert into admin_users (username, email, role) values ($1, $2, 'editor')", [`mode-${randomUUID().slice(0, 8)}`, `mode-${randomUUID().slice(0, 8)}@example.test`]);
    resetModeForTests();
    const state = await resolveMode(env);
    expect(state.mode).toBe("unavailable");
    expect(state.reason).toContain("no installation row");
    await owner.query("insert into installation (organisation_name, database_mode) values ('Mode test', 'managed')");
    resetModeForTests();
    expect((await resolveMode(env)).mode).toBe("running");
  });
});

