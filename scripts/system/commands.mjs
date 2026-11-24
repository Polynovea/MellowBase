// `polynovea-cms system <command>`: the steps the host upgrade agent (release/packer/files/upgrade-agent.py)
// runs inside a CMS container. Each prints one JSON line as its last line (the agent's receipt) and
// never prints connection strings or passwords.
//
//   system backup [--reason pre-upgrade]   bundled DB: pgBackRest backup (incremental; full if none) →
//                                           {"kind":"pgbackrest","label":...}. Managed DB: pg_dump (custom
//                                           format) to <data root>/backups/pre-upgrade, keeping the last 2 →
//                                           {"kind":"pg_dump","file":...}
//   system migrate                          pending migrations as polynovea_owner (same runner and lock as
//                                           the wizard) → {"applied":n}
//   system restore-backup --set <label> [--lsn <lsn>]
//                                           bundled DB, while the CMS is stopped: restore that backup over
//                                           the data folder (delta), to the WAL position when given
//   system mode                             {"local":true|false}: bundled database or not
//   system checkpoint                       bundled DB: the current WAL position, archived → {"lsn":...}
//   system read-only on|off                 bundled DB: the app login only reads (an upgrade's trial)
//   system restore-test --reason <reason>   the restore test (the worker starts it; restoreTestCommand.mjs)

import { promises as fs } from "node:fs";
import path from "node:path";
import { certificateAuthoritiesFor } from "../../lib/setup/database/caBundles.mjs";
import { dataRoot, freeSpace, inServerImage, installDatabase, pgbackrest, restoreCommand, runProgram, scrub, withClient } from "../../lib/system/serverHost.mjs";
import { listMigrationFiles, runMigrations } from "../run-migrations.mjs";

const LABEL = /^[0-9A-Za-z_-]{1,64}$/;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;
const KEEP_DUMPS = 2;

function fail(message) {
  console.error(`polynovea-cms system: ${message}`);
  return 1;
}

async function backup(database) {
  if (database.local) {
    if (!inServerImage()) return fail("the bundled database's tools are not in this container");
    const run = await pgbackrest(["--type=incr", "backup"]);
    if (run.code !== 0) return fail(`pgbackrest backup exited ${run.code}: ${scrub(run.stderr || run.stdout)}`);
    const info = await pgbackrest(["--output=json", "info"]);
    let label = null;
    try {
      const backups = JSON.parse(info.stdout)?.[0]?.backup ?? [];
      label = backups[backups.length - 1]?.label ?? null;
    } catch {
      label = null;
    }
    if (!label || !LABEL.test(label)) return fail("pgbackrest did not report the new backup");
    console.log(JSON.stringify({ kind: "pgbackrest", label }));
    return 0;
  }

  // Managed database: a logical dump on the data disk, after checking there is room for it.
  const folder = path.posix.join(dataRoot(), "backups", "pre-upgrade");
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const connection = database.connection("owner");
  const size = await withClient(connection, async (client) => Number((await client.query("select pg_catalog.pg_database_size(current_database()) as n")).rows[0].n));
  const { freeBytes } = await freeSpace(folder);
  if (freeBytes < size * 1.2) return fail(`not enough free disk for a pre-upgrade dump (${Math.ceil((size * 1.2) / 1e9)} GB needed)`);

  const env = { PGHOST: connection.host, PGPORT: String(connection.port ?? 5432), PGUSER: connection.user, PGPASSWORD: connection.password, PGDATABASE: connection.database, PGAPPNAME: "polynovea-pre-upgrade-dump" };
  let caFile = null;
  const caBundleId = database.config?.database?.caBundleId ?? null;
  const roots = caBundleId ? certificateAuthoritiesFor(caBundleId) : null;
  if (Array.isArray(roots) && roots.length) {
    caFile = path.posix.join(folder, ".ca.pem");
    await fs.writeFile(caFile, roots.join("\n"), { mode: 0o600 });
    Object.assign(env, { PGSSLMODE: "verify-full", PGSSLROOTCERT: caFile });
  } else if (connection.ssl) {
    Object.assign(env, { PGSSLMODE: "require" });
  }
  const file = `pre-upgrade-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
  try {
    const dumped = await runProgram("pg_dump", ["--format=custom", "--no-password", `--file=${path.posix.join(folder, file)}`], { env });
    if (dumped.code !== 0) {
      await fs.rm(path.posix.join(folder, file), { force: true });
      return fail(`pg_dump exited ${dumped.code}: ${scrub(dumped.stderr)}`);
    }
  } finally {
    if (caFile) await fs.rm(caFile, { force: true });
  }
  const dumps = (await fs.readdir(folder)).filter((name) => /^pre-upgrade-.+\.dump$/.test(name)).sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - KEEP_DUMPS))) await fs.rm(path.posix.join(folder, old), { force: true });
  console.log(JSON.stringify({ kind: "pg_dump", file }));
  return 0;
}

async function migrate(database) {
  const files = listMigrationFiles(process.env.POLYNOVEA_APP_DIR || process.cwd());
  const result = await withClient({ ...database.connection("owner"), application_name: "polynovea-upgrade-migrate" }, (client) => runMigrations(client, { files, waitForLockMs: 60_000 }));
  console.log(JSON.stringify({ applied: result.applied.length, skipped: result.skipped.length }));
  return 0;
}

async function restoreBackup(database, args) {
  const index = args.indexOf("--set");
  const label = index >= 0 ? args[index + 1] : null;
  if (!label || !LABEL.test(label)) return fail("--set <backup label> is required");
  if (!database.local || !inServerImage()) return fail("restore-backup is for the bundled database only");
  const pgdata = path.posix.join(dataRoot(), "postgresql");
  try {
    await fs.access(path.posix.join(pgdata, "postmaster.pid"));
    return fail("the bundled database is still running; stop the CMS first");
  } catch {
    // stopped, as required
  }
  // --lsn: the WAL position recorded right before the migrations (system checkpoint): every change committed
  // until then comes back, not only what the backup itself holds.
  const lsnIndex = args.indexOf("--lsn");
  const lsn = lsnIndex >= 0 ? args[lsnIndex + 1] : null;
  if (lsnIndex >= 0 && (!lsn || !LSN.test(lsn))) return fail("--lsn needs a WAL position such as 0/3000060");
  const target = lsn ? ["--type=lsn", `--target=${lsn}`] : ["--type=immediate"];
  // The spool folder: /var/spool/pgbackrest belongs to root in the image; a restore only needs an empty one.
  const run = await pgbackrest([`--set=${label}`, "--delta", ...target, "--target-action=promote", "--spool-path=/tmp/pgbackrest-spool", `--recovery-option=restore_command=${restoreCommand()}`, "restore"]);
  if (run.code !== 0) return fail(`pgbackrest restore exited ${run.code}: ${scrub(run.stderr || run.stdout)}`);
  console.log(JSON.stringify({ restored: label, lsn }));
  return 0;
}

// The bundled database's administrator, over its socket (peer authentication for the image's user).
const SUPERUSER = { host: "/var/run/postgresql", port: 5432, user: "postgres", database: "polynovea", application_name: "polynovea-upgrade" };

/** The current WAL position, then archived (pgbackrest check switches WAL and waits for the archive). */
async function checkpoint(database) {
  if (!database.local || !inServerImage()) return fail("checkpoint is for the bundled database only");
  const lsn = await withClient(SUPERUSER, async (client) => String((await client.query("select pg_catalog.pg_current_wal_lsn()::text as lsn")).rows[0].lsn));
  if (!LSN.test(lsn)) return fail("the database reported an invalid WAL position");
  const check = await pgbackrest(["check"]);
  if (check.code !== 0) return fail(`pgbackrest check exited ${check.code}: ${scrub(check.stderr || check.stdout)}`);
  console.log(JSON.stringify({ lsn }));
  return 0;
}

/**
 * read-only on|off: the app's database login only reads (default_transaction_read_only), so nothing can
 * commit while an upgrade's new release is on trial; its open sessions are ended so the change applies.
 */
async function readOnly(database, args) {
  const mode = args[0];
  if (mode !== "on" && mode !== "off") return fail("usage: system read-only on|off");
  if (!database.local || !inServerImage()) return fail("read-only is for the bundled database only");
  await withClient(SUPERUSER, async (client) => {
    await client.query(mode === "on" ? "alter role polynovea_app set default_transaction_read_only = on" : "alter role polynovea_app reset default_transaction_read_only");
    await client.query("select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = 'polynovea_app' and pid <> pg_catalog.pg_backend_pid()");
  });
  console.log(JSON.stringify({ readOnly: mode === "on" }));
  return 0;
}

export async function main(action, args) {
  if (action === "restore-test") {
    const { restoreTestCommand } = await import("./restoreTestCommand.mjs");
    return restoreTestCommand(args);
  }
  const database = installDatabase();
  if (!database) return fail("no database is configured yet (finish the setup wizard first)");
  try {
    if (action === "backup") return await backup(database);
    if (action === "migrate") return await migrate(database);
    if (action === "restore-backup") return await restoreBackup(database, args);
    if (action === "mode") {
      console.log(JSON.stringify({ local: database.local === true }));
      return 0;
    }
    if (action === "checkpoint") return await checkpoint(database);
    if (action === "read-only") return await readOnly(database, args);
  } catch (error) {
    return fail(scrub(error instanceof Error ? error.message : String(error)));
  }
  return fail("usage: polynovea-cms system backup|migrate|mode|checkpoint|read-only on|off|restore-backup --set <label> [--lsn <lsn>]|restore-test --reason <reason>");
}
