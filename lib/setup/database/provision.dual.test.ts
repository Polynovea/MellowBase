import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { appRoleProblems, tablesMissingAppPolicy } from "@/lib/db/roles.mjs";
import { localEndpoint, openClient } from "./connect";
import { DatabaseSetupError } from "./errors";
import { ALREADY_INSTALLED, provisionDatabase } from "./provision";
import type { SetupEvent } from "./stream";

// The wizard's database step against real PostgreSQL (npm run test:dual), on a fresh database created
// for this file. The admin login is polynovea_installer from scripts/dev-db/setup.mjs: CREATEROLE and
// CREATEDB, not a superuser, the same shape as the RDS master user or the Azure administrator.
//
// polynovea_owner and polynovea_app are cluster-wide roles that the other test files also log in as,
// so this test gives them their existing dev passwords back (through the password generator) instead
// of fresh random ones. Everything else is the production code path.

const env = () => process.env as Record<string, string | undefined>;
const required = (name: string) => {
  const value = env()[name];
  if (!value) throw new Error(`${name} missing from .env.test.local; run node scripts/dev-db/setup.mjs`);
  return value;
};

const DATABASE = `polynovea_setup_${randomBytes(4).toString("hex")}`;
let port: number;
let superuser: pg.Client;

async function asSuperuser(database = "polynovea") {
  const client = new pg.Client({ host: "127.0.0.1", port, database, user: "polynovea_admin", password: required("POLYNOVEA_DEV_ADMIN_PASSWORD"), ssl: false });
  await client.connect();
  return client;
}

/** Signs in as the installer and records every statement and parameter it sends. */
async function installer() {
  const client = await openClient(localEndpoint("127.0.0.1", port), DATABASE, { user: "polynovea_installer", password: required("POLYNOVEA_DEV_INSTALLER_PASSWORD") });
  const sent: unknown[] = [];
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  (client as unknown as { query: typeof query }).query = (...args: unknown[]) => {
    sent.push(args);
    return query(...args);
  };
  return { client, sent };
}

function passwords() {
  const queue = [required("POLYNOVEA_DEV_OWNER_PASSWORD"), required("POLYNOVEA_DEV_APP_PASSWORD")];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error("More passwords requested than expected");
    return next;
  };
}

async function provision(events: SetupEvent[] = []) {
  const admin = await installer();
  const result = await provisionDatabase(
    { adminClient: admin.client, endpoint: localEndpoint("127.0.0.1", port), database: DATABASE, mode: "managed", emit: (event) => events.push(event) },
    { generatePassword: passwords() },
  );
  return { result, sent: admin.sent, events };
}

beforeAll(async () => {
  port = Number(required("POLYNOVEA_DEV_PLAIN_PORT"));
  superuser = await asSuperuser();
  await superuser.query(`create database ${DATABASE} owner polynovea_installer`);
}, 30_000);

afterAll(async () => {
  await superuser?.query(`drop database if exists ${DATABASE} with (force)`).catch(() => {});
  await superuser?.end();
});

describe("database step on plain PostgreSQL with a non-superuser admin", () => {
  let first: Awaited<ReturnType<typeof provision>>;
  const logged: unknown[] = [];

  beforeAll(async () => {
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    first = await provision();
  }, 300_000);

  afterAll(() => vi.restoreAllMocks());

  it("creates the roles and runs every migration as polynovea_owner", async () => {
    expect(first.result).toMatchObject({ databaseMode: "managed", database: { host: "127.0.0.1", port, name: DATABASE }, roles: { owner: { user: "polynovea_owner" }, app: { user: "polynovea_app" } } });
    const migrations = first.events.filter((event) => event.type === "migration");
    expect(migrations.length).toBeGreaterThan(60);
    expect(migrations.filter((event) => event.status === "failed")).toEqual([]);
    const db = await asSuperuser(DATABASE);
    try {
      const { rows } = await db.query("select pg_get_userbyid(c.relowner) as owner, count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' group by 1");
      expect(rows).toEqual([{ owner: "polynovea_owner", n: expect.any(Number) }]);
    } finally {
      await db.end();
    }
  });

  it("leaves polynovea_app unable to create anything, with every row-level-security table covered", async () => {
    const db = await asSuperuser(DATABASE);
    try {
      expect(await appRoleProblems(db)).toEqual([]);
      expect(await tablesMissingAppPolicy(db)).toEqual([]);
    } finally {
      await db.end();
    }
    const app = new pg.Client({ host: "127.0.0.1", port, database: DATABASE, user: "polynovea_app", password: required("POLYNOVEA_DEV_APP_PASSWORD"), ssl: false });
    await app.connect();
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
    const sent = JSON.stringify(first.sent);
    for (const secret of ["POLYNOVEA_DEV_INSTALLER_PASSWORD", "POLYNOVEA_DEV_OWNER_PASSWORD", "POLYNOVEA_DEV_APP_PASSWORD"]) {
      expect(sent).not.toContain(required(secret));
    }
    expect(sent).toMatch(/SCRAM-SHA-256\$4096:/);
  });

  it("keeps the admin password out of every event, log line and database row (acceptance test 6)", async () => {
    const adminPassword = required("POLYNOVEA_DEV_INSTALLER_PASSWORD");
    expect(JSON.stringify(first.events)).not.toContain(adminPassword);
    expect(JSON.stringify(logged)).not.toContain(adminPassword);
    expect(JSON.stringify(first.result)).not.toContain(adminPassword);
    const db = await asSuperuser(DATABASE);
    try {
      const { rows: tables } = await db.query<{ name: string }>("select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')");
      for (const { name } of tables) {
        const { rows } = await db.query(`select count(*)::int as n from ${name} t where strpos(t::text, $1) > 0`, [adminPassword]);
        expect(rows[0].n, name).toBe(0);
      }
      const { rows: settings } = await db.query("select count(*)::int as n from pg_db_role_setting where strpos(array_to_string(setconfig, ','), $1) > 0", [adminPassword]);
      expect(settings[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("resumes a database with our ledger and no installation row: nothing re-applied", async () => {
    const again = await provision();
    const migrations = again.events.filter((event) => event.type === "migration");
    expect(migrations.length).toBeGreaterThan(60);
    expect(migrations.every((event) => event.status === "skipped")).toBe(true);
  }, 300_000);

  it("refuses a database whose installation row exists, without touching the roles", async () => {
    const owner = new pg.Client({ host: "127.0.0.1", port, database: DATABASE, user: "polynovea_owner", password: required("POLYNOVEA_DEV_OWNER_PASSWORD"), ssl: false });
    await owner.connect();
    try {
      const { rows: [{ exists }] } = await owner.query("select to_regclass('public.installation') is not null as exists");
      if (!exists) {
        // Before migration 0072 (gate-config) is on this branch: the same table, made by the owner.
        await owner.query("create table public.installation (singleton boolean primary key default true check (singleton), organisation_name text not null, database_mode text not null)");
        await owner.query("alter table public.installation enable row level security");
      }
      await owner.query("insert into public.installation (organisation_name, database_mode) values ('Test', 'managed') on conflict do nothing");
    } finally {
      await owner.end();
    }
    const admin = await installer();
    const error = await provisionDatabase(
      { adminClient: admin.client, endpoint: localEndpoint("127.0.0.1", port), database: DATABASE, mode: "managed", emit: () => {} },
      { generatePassword: passwords() },
    ).then(() => new Error("did not fail"), (e: Error) => e);
    expect(error).toBeInstanceOf(DatabaseSetupError);
    expect(error.message).toBe(ALREADY_INSTALLED);
    expect(JSON.stringify(admin.sent)).not.toMatch(/alter role|create role/);
    // The installer's temporary membership in polynovea_owner was given back.
    const db = await asSuperuser(DATABASE);
    try {
      // PostgreSQL 16+ gives a role's creator an ADMIN-only membership, so check the SET right there.
      const { rows } = await db.query(`select pg_has_role('polynovea_installer', 'polynovea_owner',
        case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end) as member`);
      expect(rows[0].member).toBe(false);
    } finally {
      await db.end();
    }
  });
});
