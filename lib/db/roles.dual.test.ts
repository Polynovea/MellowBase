import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

// Migration 0067 (database roles) checked on both test databases: plain PostgreSQL migrated as
// polynovea_owner, and Supabase's image migrated as `postgres`. These are the guards that stop a later
// migration from adding a table the app role cannot read, or a function anyone can execute.

const EXTENSION_FUNCTION = `exists (
  select 1 from pg_depend d
  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
)`;

async function connect(url: string | undefined): Promise<pg.Client> {
  if (!url) throw new Error("Test database URL missing; run node scripts/dev-db/setup.mjs");
  const client = new pg.Client({ connectionString: url, ssl: false });
  await client.connect();
  return client;
}

function catalogChecks(label: string, url: () => string | undefined) {
  describe(`database roles on ${label}`, () => {
    let db: pg.Client;
    beforeAll(async () => { db = await connect(url()); });
    afterAll(async () => { await db?.end(); });

    it("every table with row-level security has a policy for polynovea_app", async () => {
      const { rows } = await db.query(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
          and not exists (
            select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'ALL'
              and 'polynovea_app' = any(p.roles) and p.qual = 'true' and p.with_check = 'true'
          )`);
      expect(rows.map((row) => row.relname)).toEqual([]);
    });

    it("polynovea_app can read and write every table, and only read the migration ledger", async () => {
      const { rows } = await db.query(`
        select c.relname,
          has_table_privilege('polynovea_app', c.oid, 'select') as can_select,
          has_table_privilege('polynovea_app', c.oid, 'insert,update,delete') as can_write
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')`);
      expect(rows.length).toBeGreaterThanOrEqual(140);
      expect(rows.filter((row) => !row.can_select).map((row) => row.relname)).toEqual([]);
      expect(rows.filter((row) => !row.can_write).map((row) => row.relname)).toEqual(["polynovea_migration_ledger"]);
    });

    it("polynovea_app executes every SQL function and PUBLIC executes none", async () => {
      const { rows } = await db.query(`
        select p.oid::regprocedure::text as signature,
          has_function_privilege('polynovea_app', p.oid, 'execute') as app,
          exists (
            select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where a.grantee = 0 and a.privilege_type = 'EXECUTE'
          ) as public_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and not ${EXTENSION_FUNCTION}`);
      expect(rows.length).toBeGreaterThanOrEqual(56);
      const helper = "polynovea_apply_app_access()";
      expect(rows.filter((row) => !row.app && row.signature !== helper).map((row) => row.signature)).toEqual([]);
      expect(rows.find((row) => row.signature === helper)?.app).toBe(false);
      expect(rows.filter((row) => row.public_execute).map((row) => row.signature)).toEqual([]);
    });

    it("anon and authenticated (Supabase's API roles) execute no CMS SQL function", async () => {
      const { rows } = await db.query(`
        select r.rolname || ' ' || p.oid::regprocedure::text as grant
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join pg_roles r
        where n.nspname = 'public' and r.rolname in ('anon', 'authenticated')
          and not ${EXTENSION_FUNCTION}
          and has_function_privilege(r.oid, p.oid, 'execute')`);
      expect(rows.map((row) => row.grant)).toEqual([]);
    });

    it("functions created later are not executable by PUBLIC, anon or authenticated by default", async () => {
      const { rows } = await db.query(`
        select coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') as grantee
        from pg_default_acl d, aclexplode(d.defaclacl) a
        where d.defaclrole = (select oid from pg_roles where rolname = current_user)
          and d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE'
          and d.defaclnamespace in (0, 'public'::regnamespace)`);
      const grantees = rows.map((row) => row.grantee);
      expect(grantees).toContain("polynovea_app");
      expect(grantees.filter((name) => ["PUBLIC", "anon", "authenticated"].includes(name))).toEqual([]);
      // A global entry must exist, or the built-in default (PUBLIC may execute) still applies.
      const { rows: global } = await db.query(`
        select 1 from pg_default_acl
        where defaclrole = (select oid from pg_roles where rolname = current_user) and defaclobjtype = 'f' and defaclnamespace = 0`);
      expect(global).toHaveLength(1);
    });

    it("refuses to give a member a role of another workspace", async () => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const { rows: [a] } = await db.query("insert into workspaces (name, slug) values ($1, $1) returning id", [`ra-${suffix}`]);
      const { rows: [b] } = await db.query("insert into workspaces (name, slug) values ($1, $1) returning id", [`rb-${suffix}`]);
      const { rows: [user] } = await db.query("insert into admin_users (username, email) values ($1, $2) returning id", [`r-${suffix}`, `r-${suffix}@example.test`]);
      const { rows: [member] } = await db.query("insert into workspace_members (workspace_id, admin_user_id) values ($1, $2) returning id", [a.id, user.id]);
      const { rows: [own] } = await db.query("insert into roles (workspace_id, key, name) values ($1, 'own', 'Own') returning id", [a.id]);
      const { rows: [foreign] } = await db.query("insert into roles (workspace_id, key, name) values ($1, 'foreign', 'Foreign') returning id", [b.id]);
      await db.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [member.id, own.id]);
      await expect(db.query("insert into member_roles (workspace_member_id, role_id) values ($1, $2)", [member.id, foreign.id])).rejects.toMatchObject({ code: "23514" });
      await expect(db.query("update member_roles set role_id = $2 where workspace_member_id = $1", [member.id, foreign.id])).rejects.toMatchObject({ code: "23514" });
    });

    it("every SECURITY DEFINER function pins its search_path", async () => {
      const { rows } = await db.query(`
        select p.oid::regprocedure::text as signature
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) setting where setting like 'search_path=%')`);
      expect(rows.map((row) => row.signature)).toEqual([]);
    });

    it("nobody but the schema owner can create objects in public", async () => {
      const { rows: [row] } = await db.query(`
        select has_schema_privilege('polynovea_app', 'public', 'create') as app,
          exists (
            select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
            where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'CREATE'
          ) as public_create`);
      expect(row).toEqual({ app: false, public_create: false });
    });

    it("polynovea_app holds no role attributes that bypass these rules", async () => {
      const { rows: [role] } = await db.query(
        "select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = 'polynovea_app'",
      );
      expect(role).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    });

    it("later tables and functions reach polynovea_app through default privileges", async () => {
      const { rows } = await db.query(`
        select d.defaclobjtype as kind, a.privilege_type as privilege
        from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace,
          aclexplode(d.defaclacl) a
        where n.nspname = 'public' and d.defaclrole = (select oid from pg_roles where rolname = current_user)
          and a.grantee = (select oid from pg_roles where rolname = 'polynovea_app')`);
      const granted = rows.map((row) => `${row.kind}:${row.privilege}`).sort();
      expect(granted).toEqual(expect.arrayContaining(["S:SELECT", "S:USAGE", "f:EXECUTE", "r:DELETE", "r:INSERT", "r:SELECT", "r:UPDATE"]));
    });
  });
}

catalogChecks("plain PostgreSQL", () => process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL);
catalogChecks("Supabase", () => process.env.POLYNOVEA_TEST_SUPABASE_DB_URL);

describe("database roles on plain PostgreSQL, as the roles themselves", () => {
  let owner: pg.Client;
  let app: pg.Client;
  beforeAll(async () => {
    owner = await connect(process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL);
    app = await connect(process.env.POLYNOVEA_TEST_POSTGRES_URL);
    // The probe below must hit a real schema the app role does not own, not a missing one.
    await owner.query("create schema if not exists polynovea_auth");
  });
  afterAll(async () => {
    await owner?.end();
    await app?.end();
  });

  it("polynovea_owner owns every table and SQL function in public", async () => {
    const { rows } = await owner.query(`
      select 'table ' || c.relname as object from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S') and pg_get_userbyid(c.relowner) <> 'polynovea_owner'
      union all
      select 'function ' || p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and not ${EXTENSION_FUNCTION} and pg_get_userbyid(p.proowner) <> 'polynovea_owner'`);
    expect(rows.map((row) => row.object)).toEqual([]);
  });

  it.each([
    ["create table", "create table public.polynovea_ddl_probe (id int)"],
    ["create table in another schema", "create table polynovea_auth.polynovea_ddl_probe (id int)"],
    ["create schema", "create schema polynovea_ddl_probe"],
    ["create function", "create function public.polynovea_ddl_probe() returns int language sql as 'select 1'"],
    ["create view", "create view public.polynovea_ddl_probe as select 1"],
    ["create type", "create type public.polynovea_ddl_probe as enum ('a')"],
    ["create index", "create index polynovea_ddl_probe on public.taxonomies (name)"],
    ["alter table", "alter table public.taxonomies add column probe int"],
    ["disable row-level security", "alter table public.taxonomies disable row level security"],
    ["create policy", "create policy probe on public.taxonomies for all to public using (true)"],
    ["drop table", "drop table public.taxonomies"],
    ["truncate", "truncate public.taxonomies"],
    ["drop function", "drop function public.cms_merge_taxonomy_terms(uuid, uuid, uuid, uuid)"],
    ["create role", "create role polynovea_ddl_probe"],
    ["write the migration ledger", "insert into public.polynovea_migration_ledger (filename, checksum_sha256, migration_id) values ('x', 'x', 'x')"],
    ["run the access helper", "select public.polynovea_apply_app_access()"],
  ])("polynovea_app cannot %s", async (_label, statement) => {
    await expect(app.query(statement)).rejects.toMatchObject({ code: "42501" });
  });

  it("nobody but the owner may create temporary tables", async () => {
    await expect(app.query("create temporary table polynovea_temp_probe (id int)")).rejects.toMatchObject({ code: "42501" });
    const { rows: [row] } = await owner.query(`
      select exists (
        select 1 from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
        where d.datname = current_database() and a.grantee = 0 and a.privilege_type = 'TEMPORARY'
      ) as public_temp`);
    expect(row.public_temp).toBe(false);
  });

  it("the install roles hold no bypass attributes and the installer is not a superuser", async () => {
    const { rows } = await owner.query(`
      select rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles
      where rolname in ('polynovea_owner', 'polynovea_app', 'polynovea_installer') order by rolname`);
    expect(rows).toEqual([
      { rolname: "polynovea_app", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
      { rolname: "polynovea_installer", rolsuper: false, rolcreaterole: true, rolcreatedb: true, rolbypassrls: false },
      { rolname: "polynovea_owner", rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false },
    ]);
    // The installer's temporary membership in polynovea_owner was revoked.
    const { rows: [member] } = await owner.query("select pg_has_role('polynovea_installer', 'polynovea_owner', 'USAGE') as usage");
    expect(member.usage).toBe(false);
  });

  it("a GRANT from polynovea_app gives nothing away", async () => {
    // PostgreSQL only warns when a role without grant option grants; check the privilege stays absent.
    await app.query("grant select on public.taxonomies to public");
    const { rows: [row] } = await owner.query("select has_table_privilege('public', 'public.taxonomies', 'select') as granted");
    expect(row.granted).toBe(false);
  });

  it("polynovea_app reads and writes rows through row-level security", async () => {
    const slug = `roles-probe-${Date.now()}`;
    await app.query("begin");
    try {
      await app.query("insert into workspaces (name, slug) values ($1, $2)", ["Roles probe", slug]);
      const { rowCount } = await app.query("select 1 from workspaces where slug = $1", [slug]);
      expect(rowCount).toBe(1);
    } finally {
      await app.query("rollback");
    }
  });

  it("polynovea_app can call a SQL function", async () => {
    await expect(app.query("select public.cms_age_analytics_freshness()")).resolves.toBeDefined();
  });
});
