// Ordered PostgreSQL migration runner for installation and controlled upgrades.
//
// Command line: connects with the install's config.enc (owner login and its CA bundle) when it exists,
// otherwise with DATABASE_URL from .env.local or the process environment (see migrationConnection).
//   node scripts/run-migrations.mjs --all
//   node scripts/run-migrations.mjs <file1.sql> [file2.sql ...]
//
// Module: `runMigrations(client, { files, onProgress })` applies them over a client the caller has
// connected (the setup wizard connects as polynovea_owner and streams each step to the browser).
//
// Applied migration files are immutable. Each successful file is recorded in
// public.polynovea_migration_ledger with its SHA-256 checksum. Re-running an identical applied
// migration is a no-op; a checksum mismatch fails closed.
//
// Two runs never interleave: an in-process lock covers callers in the same server, and a PostgreSQL
// advisory lock covers other processes (a second server, or this script run by hand).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { postgresConnectionConfig } from "../lib/infrastructure/postgresTls.mjs";
import { ensureCompatibilityRoles } from "../lib/db/roles.mjs";
import { configPath, databaseUrlFromConfig, readInstallConfigSync } from "../lib/setup/configStore.mjs";
import { tlsConnectionFor } from "../lib/setup/installConnection.mjs";

const LEDGER_TABLE = "polynovea_migration_ledger";
/** Advisory lock key for migrations: the bytes of "PLYMIGR" as a bigint. */
export const MIGRATION_LOCK_KEY = "22601944569300818";

export class MigrationLockError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationLockError";
  }
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function migrationId(filename) {
  return path.basename(filename).match(/^(\d{4})/)?.[1] ?? path.basename(filename);
}

/**
 * Every numbered migration in supabase/migrations, in order.
 * @param {string} [root] the repository root (default: the working directory)
 * @returns {string[]} paths
 */
export function listMigrationFiles(root = process.cwd()) {
  return readdirSync(path.resolve(root, "supabase/migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => path.join(root, "supabase", "migrations", name));
}

async function ensureLedger(client) {
  const { rows: [state] } = await client.query(`
    select
      to_regclass('public.${LEDGER_TABLE}') is not null as ledger_exists,
      to_regclass('public.workspaces') is not null as core_exists
  `);

  if (!state.ledger_exists && state.core_exists) {
    throw new Error(
      "This database already contains Polynovea core tables but has no migration ledger. " +
      "Automatic adoption is blocked because applied migration provenance cannot be proven.",
    );
  }

  await client.query(`create table if not exists public.${LEDGER_TABLE}(
    filename text primary key,
    checksum_sha256 text not null,
    migration_id text not null,
    applied_at timestamptz not null default now()
  )`);
}

let inProcess = null;

async function takeAdvisoryLock(client, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows: [row] } = await client.query("select pg_try_advisory_lock($1::bigint) as locked", [MIGRATION_LOCK_KEY]);
    if (row.locked) return;
    if (Date.now() >= deadline) throw new MigrationLockError("Another migration run holds the database's migration lock");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * @typedef {{ type: "migration", filename: string, index: number, total: number, status: "running" | "applied" | "skipped" | "failed" }} MigrationProgress
 */

/**
 * Applies `files` in order over `client` (already connected; the caller ends it).
 * @param {import("pg").ClientBase} client
 * @param {{ files?: string[], root?: string, onProgress?: (event: MigrationProgress) => void, waitForLockMs?: number }} [options]
 *   `waitForLockMs`: how long to wait for another run to finish (default 0: fail at once).
 * @returns {Promise<{ applied: string[], skipped: string[], createdRoles: string[] }>}
 */
export async function runMigrations(client, options = {}) {
  if (inProcess) throw new MigrationLockError("A migration run is already in progress in this server");
  let release;
  inProcess = new Promise((resolve) => { release = resolve; });
  try {
    await takeAdvisoryLock(client, options.waitForLockMs ?? 0);
    try {
      return await applyAll(client, options);
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    inProcess = null;
    release();
  }
}

async function applyAll(client, options) {
  const files = options.files ?? listMigrationFiles(options.root);
  const progress = options.onProgress ?? (() => {});
  // Migrations 0003-0065 grant to Supabase's role names; a plain database needs them first.
  const createdRoles = await ensureCompatibilityRoles(client);
  await ensureLedger(client);

  const applied = [];
  const skipped = [];
  for (const [index, file] of files.entries()) {
    const filename = path.basename(file);
    const id = migrationId(filename);
    const sql = readFileSync(file, "utf8");
    const hash = checksum(sql);
    const base = { type: "migration", filename, index: index + 1, total: files.length };
    const { rows: [recorded] } = await client.query(
      `select checksum_sha256 from public.${LEDGER_TABLE} where filename=$1`,
      [filename],
    );

    if (recorded) {
      if (recorded.checksum_sha256 !== hash) {
        progress({ ...base, status: "failed" });
        throw new Error(`Applied migration checksum mismatch: ${filename}. Applied migrations are immutable.`);
      }
      skipped.push(filename);
      progress({ ...base, status: "skipped" });
      continue;
    }

    progress({ ...base, status: "running" });
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `insert into public.${LEDGER_TABLE}(filename,checksum_sha256,migration_id) values($1,$2,$3)`,
        [filename, hash, id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      progress({ ...base, status: "failed" });
      throw err;
    }
    applied.push(filename);
    progress({ ...base, status: "applied" });
  }

  const latest = files.map((file) => migrationId(file)).sort().at(-1);
  if (latest) {
    await client.query(
      "update cms_runtime_state set schema_migration=$1,updated_at=now() where singleton=true",
      [latest],
    ).catch(() => {});
  }
  return { applied, skipped, createdRoles };
}

// ---------------------------------------------------------------------------------------------------
// Command line

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Where the command line connects.
 *
 * - On an install the setup wizard made, config.enc is the source of truth: the owner login, the
 *   endpoint name and the CA bundle the wizard verified the database with (tlsConnectionFor). If
 *   config.enc exists but cannot be read (wrong master key, damaged file), this refuses: falling back
 *   to DATABASE_URL could migrate a different database than the one the CMS runs on.
 * - Without config.enc (development, installs from before the wizard): DATABASE_URL, with the shared
 *   TLS policy (postgresTls.mjs).
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ source: "config.enc" | "DATABASE_URL", file: string, connectionString: string, ssl: false | object }}
 */
export function migrationConnection(env = process.env) {
  const file = configPath(env);
  let config;
  try {
    config = readInstallConfigSync(env);
  } catch (error) {
    throw new Error(
      `${file} exists but cannot be used (${error instanceof Error ? error.message : String(error)}). `
      + "Fix it or restore the master key; DATABASE_URL is not used while config.enc exists.",
    );
  }
  if (config) {
    return { source: "config.enc", file, ...tlsConnectionFor(databaseUrlFromConfig(config, "owner"), config.database, env) };
  }
  const connectionString = env.Database_URL || env.DATABASE_URL || env.database_url;
  if (!connectionString) throw new Error(`No ${file} and no Database_URL / DATABASE_URL in .env.local or the process environment`);
  return { source: "DATABASE_URL", file, ...postgresConnectionConfig(connectionString, env) };
}

async function main() {
  loadEnvLocal();

  let connection;
  try {
    connection = migrationConnection(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(connection.source === "config.enc"
    ? `Using the install's settings in ${connection.file}, as polynovea_owner.`
    : `No ${connection.file}; using DATABASE_URL.`);

  const requested = process.argv.slice(2);
  const files = requested.length === 1 && requested[0] === "--all"
    ? listMigrationFiles().map((file) => path.relative(process.cwd(), file))
    : requested;

  if (files.length === 0) {
    console.error("Usage: node scripts/run-migrations.mjs --all | <file1.sql> [file2.sql ...]");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: connection.connectionString, ssl: connection.ssl });
  let running = null;
  try {
    await client.connect();
    console.log("Connected.\n");
    const result = await runMigrations(client, {
      files,
      // By hand, wait for a run that is already going (an upgrade, the wizard) rather than fail.
      waitForLockMs: 10 * 60_000,
      onProgress: (event) => {
        const file = files[event.index - 1];
        if (event.status === "skipped") console.log(`=== ${file} ... already applied`);
        else if (event.status === "running") process.stdout.write(`=== ${file} ... `);
        else if (event.status === "applied") console.log("OK");
        else if (event.status === "failed") console.log(running === file ? "FAILED" : `=== ${file} ... FAILED`);
        running = event.status === "running" ? file : null;
      },
    });
    if (result.createdRoles.length) console.log(`\nCreated NOLOGIN compatibility role(s): ${result.createdRoles.join(", ")}`);
    await client.end();
    console.log("\nAll requested migrations are reconciled successfully.");
  } catch (err) {
    console.error("Fatal error:", err instanceof Error ? err.message : String(err));
    await client.end().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
