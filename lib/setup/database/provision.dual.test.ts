import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { appRoleProblems, tablesMissingAppPolicy } from "@/lib/db/roles.mjs";
import { listMigrationFiles } from "@/scripts/run-migrations.mjs";
import { localEndpoint, openClient } from "./connect";
import { DatabaseSetupError } from "./errors";
import { migrateAsOwner } from "./migrate";
import { ALREADY_INSTALLED, provisionDatabase, ROLES_IN_USE, type ProvisionDeps, type ProvisionedDatabase } from "./provision";
import type { SetupEvent } from "./stream";

// The wizard's database step against real PostgreSQL (npm run test:dual).
//
// polynovea_owner and polynovea_app are cluster-wide, and the shared test server's `polynovea` database
// already relies on them, so the step (rightly) refuses to provision a second database there. The main
// path therefore runs on a throwaway PostgreSQL container of the same version, started by this file:
// its admin login is polynovea_installer (CREATEROLE and CREATEDB, not a superuser), the same shape as
// the RDS master user or the Azure administrator. The shared server is used for the refusal case.

const env = () => process.env as Record<string, string | undefined>;
const required = (name: string) => {
  const value = env()[name];
  if (!value) throw new Error(`${name} missing from .env.test.local; run node scripts/dev-db/setup.mjs`);
  return value;
};
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function connectWhenReady(config: pg.ClientConfig, timeoutMs = 90_000): Promise<pg.Client> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ ...config, ssl: false, connectionTimeoutMillis: 3_000 });
    try {
      await client.connect();
      await client.query("select 1");
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** Signs in as the installer and records every statement and parameter it sends. */
async function recordingInstaller(port: number, database: string, password: string) {
  const client = await openClient(localEndpoint("127.0.0.1", port), database, { user: "polynovea_installer", password });
  const sent: unknown[] = [];
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  (client as unknown as { query: typeof query }).query = (...args: unknown[]) => {
    sent.push(args);
    return query(...args);
  };
  return { client, sent };
}

const migrationsBefore0072: ProvisionDeps["migrate"] = (client, options) =>
  migrateAsOwner(client, { ...options, files: listMigrationFiles().filter((file) => path.basename(file) < "0072") });

describe("database step on an isolated PostgreSQL server, with a non-superuser admin", () => {
  const DATABASE = "polynovea_setup";
  const ADMIN_PASSWORD = `admin-${randomBytes(12).toString("hex")}`;
  const INSTALLER_PASSWORD = `installer-${randomBytes(12).toString("hex")}`;
  let container = "";
  let port = 0;
  let superuser: (database?: string) => Promise<pg.Client>;
  const logged: unknown[] = [];
  const results: { result: ProvisionedDatabase; sent: unknown[]; events: SetupEvent[] }[] = [];

  async function provision(deps: ProvisionDeps = {}) {
    const events: SetupEvent[] = [];
    const admin = await recordingInstaller(port, DATABASE, INSTALLER_PASSWORD);
    const result = await provisionDatabase(
      { adminClient: admin.client, endpoint: localEndpoint("127.0.0.1", port), database: DATABASE, mode: "managed", emit: (event) => events.push(event) },
      deps,
    ).then((value) => value, (error: Error) => ({ error, sent: admin.sent, events }));
    if ("error" in result) return result;
    const run = { result, sent: admin.sent, events };
    results.push(run);
    return run;
  }

  async function asOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const latest = results.at(-1)!.result;
    const client = await connectWhenReady({ host: "127.0.0.1", port, database: DATABASE, user: "polynovea_owner", password: latest.roles.owner.password });
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    const image = `postgres:${env().POLYNOVEA_DEV_PG_VERSION || "16"}-alpine`;
    container = docker("run", "-d", "--rm", "-e", "POSTGRES_USER=polynovea_admin", "-e", `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`, "-e", "POSTGRES_DB=postgres", "-p", "127.0.0.1::5432", image);
    port = Number(docker("port", container, "5432/tcp").split("\n")[0].split(":").at(-1));
    superuser = (database = "postgres") => connectWhenReady({ host: "127.0.0.1", port, database, user: "polynovea_admin", password: ADMIN_PASSWORD });
    const root = await superuser();
    try {
      await root.query(`create role polynovea_installer login nosuperuser createrole createdb nobypassrls password ${root.escapeLiteral(INSTALLER_PASSWORD)}`);
      await root.query(`create database ${DATABASE} owner polynovea_installer`);
    } finally {
      await root.end();
    }
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
  }, 180_000);

  afterAll(() => {
    vi.restoreAllMocks();
    if (container) docker("rm", "-f", container);
  });

  it("sets up a fresh database as far as an install from before migration 0072", async () => {
    const run = await provision({ migrate: migrationsBefore0072 });
    expect("error" in run).toBe(false);
  }, 300_000);

  it("refuses that database once it has an admin user, without touching the roles", async () => {
    await asOwner((owner) => owner.query("insert into public.admin_users (username, email, role) values ('owner', 'owner@example.test', 'master')"));
    const run = await provision();
    expect("error" in run && run.error).toBeInstanceOf(DatabaseSetupError);
    expect("error" in run && run.error.message).toBe(ALREADY_INSTALLED);
    expect(JSON.stringify(run.sent)).not.toMatch(/alter role|create role/);
    await asOwner((owner) => owner.query("delete from public.admin_users"));
  }, 120_000);

  it("resumes the empty seeded database: the remaining migrations run, nothing is re-applied", async () => {
    const run = await provision();
    expect("error" in run).toBe(false);
    const migrations = run.events.filter((event) => event.type === "migration");
    const applied = migrations.filter((event) => event.status === "applied").map((event) => (event as { filename: string }).filename);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((filename) => filename >= "0072")).toBe(true);
    expect(migrations.filter((event) => event.status === "failed")).toEqual([]);
    expect(await asOwner(async (owner) => (await owner.query("select count(*)::int as n from public.workspaces")).rows[0].n)).toBe(1);
  }, 300_000);

  it("leaves every table owned by polynovea_owner and polynovea_app unable to create anything", async () => {
    const db = await superuser(DATABASE);
    try {
      const { rows } = await db.query("select distinct pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'");
      expect(rows).toEqual([{ owner: "polynovea_owner" }]);
      expect(await appRoleProblems(db)).toEqual([]);
      expect(await tablesMissingAppPolicy(db)).toEqual([]);
    } finally {
      await db.end();
    }
    const app = await connectWhenReady({ host: "127.0.0.1", port, database: DATABASE, user: "polynovea_app", password: results.at(-1)!.result.roles.app.password });
    try {
      for (const ddl of ["create table public.app_made()", "create temporary table app_temp()", "create schema app_schema", "create function public.app_fn() returns int language sql as 'select 1'", "create view public.app_view as select 1", "drop table public.workspaces", "alter table public.workspaces add column x int"]) {
        await expect(app.query(ddl), ddl).rejects.toMatchObject({ code: expect.stringMatching(/^42501$|^42P01$/) });
      }
      await expect(app.query("select count(*) from public.workspaces")).resolves.toBeTruthy();
    } finally {
      await app.end();
    }
  });

  it("never sends a role password or the admin password to the server in plain text (acceptance test 6)", () => {
    for (const run of results) {
      const sent = JSON.stringify(run.sent);
      for (const secret of [INSTALLER_PASSWORD, run.result.roles.owner.password, run.result.roles.app.password]) expect(sent).not.toContain(secret);
      expect(sent).toMatch(/SCRAM-SHA-256\$4096:/);
    }
  });

  it("keeps the admin password out of every event, log line and database row (acceptance test 6)", async () => {
    for (const run of results) {
      expect(JSON.stringify(run.events)).not.toContain(INSTALLER_PASSWORD);
      expect(JSON.stringify(run.result)).not.toContain(INSTALLER_PASSWORD);
    }
    expect(JSON.stringify(logged)).not.toContain(INSTALLER_PASSWORD);
    const db = await superuser(DATABASE);
    try {
      const { rows: tables } = await db.query<{ name: string }>("select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')");
      for (const { name } of tables) {
        const { rows } = await db.query(`select count(*)::int as n from ${name} t where strpos(t::text, $1) > 0`, [INSTALLER_PASSWORD]);
        expect(rows[0].n, name).toBe(0);
      }
      const { rows: settings } = await db.query("select count(*)::int as n from pg_db_role_setting where strpos(array_to_string(setconfig, ','), $1) > 0", [INSTALLER_PASSWORD]);
      expect(settings[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("refuses a database whose installation row exists, without touching the roles", async () => {
    await asOwner((owner) => owner.query("insert into public.installation (organisation_name, database_mode) values ('Test', 'managed') on conflict do nothing"));
    const run = await provision();
    expect("error" in run && run.error.message).toBe(ALREADY_INSTALLED);
    expect(JSON.stringify(run.sent)).not.toMatch(/alter role|create role/);
    // The installer's temporary membership in polynovea_owner was given back (PostgreSQL 16+ gives a
    // role's creator an ADMIN-only membership, so the SET right is what must be gone).
    const db = await superuser(DATABASE);
    try {
      const { rows } = await db.query(`select pg_has_role('polynovea_installer', 'polynovea_owner',
        case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end) as member`);
      expect(rows[0].member).toBe(false);
    } finally {
      await db.end();
    }
  }, 120_000);
});

describe("database step on a server where another database already uses the Polynovea roles", () => {
  const DATABASE = `polynovea_setup_${randomBytes(4).toString("hex")}`;
  let port: number;
  let superuser: pg.Client;

  beforeAll(async () => {
    port = Number(required("POLYNOVEA_DEV_PLAIN_PORT"));
    superuser = await connectWhenReady({ host: "127.0.0.1", port, database: "polynovea", user: "polynovea_admin", password: required("POLYNOVEA_DEV_ADMIN_PASSWORD") });
    await superuser.query(`create database ${DATABASE} owner polynovea_installer`);
  }, 30_000);

  afterAll(async () => {
    await superuser?.query(`drop database if exists ${DATABASE} with (force)`).catch(() => {});
    await superuser?.end();
  });

  it("refuses before changing anything, and the other database's logins keep working", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = await recordingInstaller(port, DATABASE, required("POLYNOVEA_DEV_INSTALLER_PASSWORD"));
    const error = await provisionDatabase(
      { adminClient: admin.client, endpoint: localEndpoint("127.0.0.1", port), database: DATABASE, mode: "managed", emit: () => {} },
      { generatePassword: () => `would-reset-${randomBytes(16).toString("hex")}` },
    ).then(() => new Error("did not fail"), (e: Error) => e);
    vi.restoreAllMocks();
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error.message).toBe(ROLES_IN_USE);
    expect(JSON.stringify(admin.sent)).not.toMatch(/alter role|create role|grant connect/);
    for (const [user, password] of [["polynovea_owner", required("POLYNOVEA_DEV_OWNER_PASSWORD")], ["polynovea_app", required("POLYNOVEA_DEV_APP_PASSWORD")]]) {
      const client = new pg.Client({ host: "127.0.0.1", port, database: "polynovea", user, password, ssl: false });
      await client.connect();
      await client.end();
    }
  });
});
