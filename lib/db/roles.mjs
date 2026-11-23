// Database roles for installs without Supabase (self-hosted upgrade, phase 1).
//
// Two steps happen before the numbered migrations can run on a plain PostgreSQL database:
//
// 1. Install roles (one-time, as the database's admin login: the RDS or Azure master user, or the
//    bundled server's superuser): polynovea_owner owns schema public and runs migrations,
//    polynovea_app is the runtime login. `bootstrapInstallRoles` does this; the setup wizard and the
//    local dev databases (scripts/dev-db/setup.mjs) call it.
// 2. Compatibility roles: migrations 0003-0065 grant to or revoke from Supabase's role names
//    (anon, authenticated, service_role, postgres). They must exist, as NOLOGIN roles with no
//    attributes, before those migrations run. `ensureCompatibilityRoles` creates any that are missing
//    when the connected login may create roles, and otherwise says exactly what an administrator must
//    run. scripts/run-migrations.mjs calls it before applying anything.
//
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

// Migration 0067 then gives polynovea_app its grants and a row-level security policy on every table.

/** Role names the historical migrations reference. NOLOGIN, no privileges of their own. */
export const COMPATIBILITY_ROLES = Object.freeze(["anon", "authenticated", "service_role", "postgres"]);

export const OWNER_ROLE = "polynovea_owner";
export const APP_ROLE = "polynovea_app";

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteIdent(name) {
  if (!ROLE_NAME.test(name)) throw new Error(`Refusing unexpected role or database name: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** @param {import("pg").ClientBase} client */
export async function missingCompatibilityRoles(client) {
  const { rows } = await client.query(
    "select name from unnest($1::text[]) as name where not exists (select 1 from pg_roles where rolname = name)",
    [COMPATIBILITY_ROLES],
  );
  return rows.map((row) => row.name);
}

/**
 * Creates the missing compatibility roles as NOLOGIN, or throws with the statements an administrator
 * must run when the connected login cannot create roles (polynovea_owner never can).
 * @param {import("pg").ClientBase} client
 * @returns {Promise<string[]>} the roles it created
 */
export async function ensureCompatibilityRoles(client) {
  const missing = await missingCompatibilityRoles(client);
  if (missing.length === 0) return [];
  const { rows: [me] } = await client.query(
    "select rolsuper or rolcreaterole as can_create from pg_roles where rolname = current_user",
  );
  if (!me?.can_create) {
    const statements = missing.map((name) => `create role ${quoteIdent(name)} nologin;`).join(" ");
    throw new Error(
      `The database is missing role(s) ${missing.join(", ")} that the migrations grant to. `
      + `Ask the database administrator to run: ${statements}`,
    );
  }
  for (const name of missing) {
    // Re-checked inside the statement: another installer may have created it meanwhile.
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${name}') then create role ${quoteIdent(name)} nologin; end if;
    end $$`);
  }
  return missing;
}

/**
 * A SCRAM-SHA-256 password verifier in PostgreSQL's stored format. ALTER ROLE ... PASSWORD with a
 * verifier stores it as is, so the plaintext never reaches the server (or a log_statement=ddl log).
 * @param {string} password
 */
export function scramSha256Verifier(password, { iterations = 4096, salt = randomBytes(16) } = {}) {
  // SASLprep is approximated by NFKC normalisation; generated passwords are ASCII anyway.
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * One-time install step, as the admin login: creates or updates polynovea_owner and polynovea_app
 * with their passwords, gives the owner schema public, and closes schema public and temporary
 * tables to everyone else. Also creates the compatibility roles.
 *
 * Works with the admin login managed databases give (RDS master user, Azure administrator): a
 * non-superuser with CREATEROLE and CREATEDB that owns the target database. So it never names
 * SUPERUSER or BYPASSRLS (only a superuser may), and it verifies afterwards that neither role holds
 * an attribute that bypasses our rules.
 *
 * @param {import("pg").ClientBase} client connected as the admin login to the target database
 * @param {{ database: string, ownerPassword: string, appPassword: string }} options
 */
export async function bootstrapInstallRoles(client, { database, ownerPassword, appPassword }) {
  if (!ownerPassword || !appPassword) throw new Error("Both role passwords are required");
  if (ownerPassword === appPassword) throw new Error("The owner and app roles must not share a password");
  const db = quoteIdent(database);
  const owner = quoteIdent(OWNER_ROLE);
  for (const role of [OWNER_ROLE, APP_ROLE]) {
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${quoteIdent(role)} login; end if;
    end $$`);
  }
  // ALTER ROLE ... PASSWORD takes no bind parameters; the verifier is base64 and quoted as a literal.
  await client.query(`alter role ${owner} with login password ${client.escapeLiteral(scramSha256Verifier(ownerPassword))}`);
  await client.query(`alter role ${quoteIdent(APP_ROLE)} with login password ${client.escapeLiteral(scramSha256Verifier(appPassword))}`);
  await assertNoBypassAttributes(client);

  await client.query(`grant connect, create on database ${db} to ${owner}`);
  await client.query(`grant connect on database ${db} to ${quoteIdent(APP_ROLE)}`);
  await client.query(`revoke temporary on database ${db} from public`);

  // Close schema public to everyone else while the admin still controls it (on PostgreSQL 15+ it is
  // owned by pg_database_owner, which the database's owner belongs to). After the owner change only
  // polynovea_owner can do this; the setup wizard repeats it as that role (hardenPublicSchema).
  await client.query("revoke create on schema public from public");
  // Changing a schema's owner requires being able to SET ROLE to the new owner. A superuser can; the
  // managed-database admin is given that right for this one statement and loses it straight after.
  await withOwnerRole(client, () => client.query(`alter schema public owner to ${owner}`));
  await ensureCompatibilityRoles(client);
}

/**
 * Throws if polynovea_owner or polynovea_app holds SUPERUSER, CREATEROLE, CREATEDB or BYPASSRLS.
 * @param {import("pg").ClientBase} client
 */
export async function assertNoBypassAttributes(client) {
  const { rows } = await client.query(
    `select rolname from pg_roles where rolname = any($1::text[])
       and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls)`,
    [[OWNER_ROLE, APP_ROLE]],
  );
  if (rows.length) {
    throw new Error(
      `Role(s) ${rows.map((row) => row.rolname).join(", ")} hold SUPERUSER, CREATEROLE, CREATEDB or BYPASSRLS. `
      + "Remove those attributes (as a superuser) before installing.",
    );
  }
}

/**
 * Runs `fn` while the admin login may act as polynovea_owner: a superuser always can; a managed
 * admin (CREATEROLE, the role's creator) is granted membership for the call and loses it straight
 * after. With `setRole`, the statements in `fn` run as polynovea_owner (SET ROLE ... RESET ROLE).
 * @template T
 * @param {import("pg").ClientBase} client
 * @param {() => Promise<T>} fn
 * @param {{ setRole?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function withOwnerRole(client, fn, { setRole = false } = {}) {
  const owner = quoteIdent(OWNER_ROLE);
  const { rows: [me] } = await client.query(
    `select r.rolsuper as superuser, current_setting('server_version_num')::int as version,
       pg_has_role(current_user, $1, case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end) as member
     from pg_roles r where r.rolname = current_user`,
    [OWNER_ROLE],
  );
  const temporaryMembership = !me.superuser && !me.member;
  if (temporaryMembership) {
    await client.query(me.version >= 160000
      ? `grant ${owner} to current_user with set true, inherit false`
      : `grant ${owner} to current_user`);
  }
  try {
    if (!setRole) return await fn();
    await client.query(`set role ${owner}`);
    try {
      return await fn();
    } finally {
      await client.query("reset role");
    }
  } finally {
    if (temporaryMembership) await client.query(`revoke ${owner} from current_user`);
  }
}

/**
 * Where a database stands before the wizard touches it, checked as the admin login before any role
 * or password changes:
 * - "fresh": no Polynovea objects; set it up.
 * - "resumable": our migration ledger but no installation row (an earlier attempt stopped part-way);
 *   roles are reset and the remaining migrations run.
 * - "installed": the installation row exists; this database already belongs to an install.
 * - "foreign": Polynovea tables without our ledger, or an installation table we cannot read as
 *   polynovea_owner; refused, because we cannot prove what is there.
 * @param {import("pg").ClientBase} client connected as the admin login
 * @returns {Promise<"fresh" | "resumable" | "installed" | "foreign">}
 */
export async function installationState(client) {
  const { rows: [state] } = await client.query(`select
      to_regclass('public.installation') is not null as has_installation,
      to_regclass('public.polynovea_migration_ledger') is not null as has_ledger,
      to_regclass('public.workspaces') is not null as has_core,
      (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = to_regclass('public.installation')) as installation_owner`);
  if (!state.has_ledger) return state.has_core || state.has_installation ? "foreign" : "fresh";
  if (!state.has_installation) return "resumable";
  // Row-level security hides the row from every role but the table's owner, so read it as the owner.
  if (state.installation_owner !== OWNER_ROLE) return "foreign";
  try {
    const installed = await withOwnerRole(client, async () => {
      const { rows } = await client.query("select exists (select 1 from public.installation) as installed");
      return rows[0]?.installed === true;
    }, { setRole: true });
    return installed ? "installed" : "resumable";
  } catch (error) {
    // 42501: this admin may not act as polynovea_owner (another login created the roles).
    if (error && typeof error === "object" && error.code === "42501") return "foreign";
    throw error;
  }
}

/**
 * As polynovea_owner after the schema changed hands: nobody else may create in schema public. Runs
 * again here because databases upgraded from before PostgreSQL 15 still grant it to PUBLIC.
 * @param {import("pg").ClientBase} ownerClient
 */
export async function hardenPublicSchema(ownerClient) {
  await ownerClient.query("revoke create on schema public from public");
}

/**
 * Every way polynovea_app could create or change structure, as a list of problems (empty is good):
 * bypass attributes, CREATE on any schema, CREATE or TEMPORARY on the database, membership in any
 * role, or ownership of anything.
 * @param {import("pg").ClientBase} client any login in the target database
 * @returns {Promise<string[]>}
 */
export async function appRoleProblems(client) {
  const { rows: [row] } = await client.query(`select
      (select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_catalog.pg_roles where rolname = $1) as bypass,
      array(select n.nspname::text from pg_catalog.pg_namespace n where pg_catalog.has_schema_privilege($1, n.oid, 'CREATE') order by 1) as create_schemas,
      pg_catalog.has_database_privilege($1, current_database(), 'CREATE') as create_database,
      pg_catalog.has_database_privilege($1, current_database(), 'TEMPORARY') as temporary,
      array(select pg_catalog.pg_get_userbyid(m.roleid)::text from pg_catalog.pg_auth_members m where m.member = to_regrole($1) order by 1) as member_of,
      (select count(*) from pg_catalog.pg_class where relowner = to_regrole($1))
        + (select count(*) from pg_catalog.pg_proc where proowner = to_regrole($1))
        + (select count(*) from pg_catalog.pg_namespace where nspowner = to_regrole($1))
        + (select count(*) from pg_catalog.pg_type where typowner = to_regrole($1)) as owned`,
    [APP_ROLE],
  );
  const problems = [];
  if (row.bypass === null || row.bypass === undefined) problems.push(`${APP_ROLE} does not exist`);
  if (row.bypass) problems.push(`${APP_ROLE} holds SUPERUSER, CREATEROLE, CREATEDB or BYPASSRLS`);
  if (row.create_schemas.length) problems.push(`${APP_ROLE} may create objects in schema(s) ${row.create_schemas.join(", ")}`);
  if (row.create_database) problems.push(`${APP_ROLE} may create schemas in the database`);
  if (row.temporary) problems.push(`${APP_ROLE} may create temporary tables`);
  if (row.member_of.length) problems.push(`${APP_ROLE} is a member of ${row.member_of.join(", ")}`);
  if (Number(row.owned) > 0) problems.push(`${APP_ROLE} owns ${row.owned} object(s)`);
  return problems;
}

/**
 * Tables in schema public with row-level security on and no permissive all-rows policy for
 * polynovea_app (migration 0067's polynovea_app_all). Must be empty after migrations.
 * @param {import("pg").ClientBase} client
 * @returns {Promise<string[]>}
 */
export async function tablesMissingAppPolicy(client) {
  const { rows } = await client.query(`
    select c.relname::text as relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
      and not exists (
        select 1 from pg_catalog.pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname and p.cmd = 'ALL'
          and $1 = any(p.roles) and p.qual = 'true' and p.with_check = 'true'
      )
    order by 1`, [APP_ROLE]);
  return rows.map((row) => row.relname);
}
