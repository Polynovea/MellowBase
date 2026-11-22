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

  // Changing a schema's owner requires being able to SET ROLE to the new owner. A superuser can; the
  // managed-database admin is given that right for this one statement and loses it straight after.
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
    await client.query(`alter schema public owner to ${owner}`);
  } finally {
    if (temporaryMembership) await client.query(`revoke ${owner} from current_user`);
  }
  await client.query("revoke create on schema public from public");
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
