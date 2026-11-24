// The restore test of the bundled database's backups (design: "Operations → Monthly restore test").
// Plain JavaScript so the delivery worker (plain Node) can run it; scripts/system/restore-test.mjs is
// the entry point, started by the worker at low CPU and IO priority (nice, ionice).
//
// 1. Clean up anything a killed earlier run left behind (stop its temporary PostgreSQL, delete it).
// 2. Ask pgBackRest for the newest backup and check free disk first: at least 1.2 × the database size
//    plus the live WAL. Short of that, the test is "skipped" with a warning instead of filling the disk.
// 3. Restore that backup into <data root>/restore-test/<id> (--type=immediate, archive-mode=off, so
//    nothing is ever pushed into the live backup repository).
// 4. Start a temporary PostgreSQL there with no TCP listener (its own socket folder, port 5439),
//    no archiving and no log collector (the live logs are never touched).
// 5. Compare with the live database: the restored migration ledger is a subset of the live one and
//    every file missing from it was applied after the backup; core tables that have rows live have rows
//    restored. Record the counts.
// 6. Stop it and delete the folder, always (finally), even when a step failed.
//
// A failed test is recorded as "failed" (a blocking System Doctor finding, an audit event and a banner
// on the System page), never only logged. Messages are fixed text: no paths with secrets, no DSNs.

import path from "node:path";

export const TEMP_PORT = 5439;
export const DISK_FACTOR = 1.2;
export const CORE_TABLES = Object.freeze(["polynovea_migration_ledger", "installation", "admin_users", "workspaces", "content_entries"]);
const LABEL = /^[0-9A-Za-z_-]{1,64}$/;

export class RestoreTestError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @typedef {object} RestoreHost
 * @property {(args: string[]) => Promise<{ code: number, stdout: string }>} pgbackrest
 * @property {(args: string[]) => Promise<{ code: number }>} pgCtl
 * @property {(dir: string) => Promise<{ freeBytes: number }>} freeSpace
 * @property {(dir: string) => Promise<number>} directorySize
 * @property {(dir: string) => Promise<string[]>} list
 * @property {(file: string) => Promise<boolean>} exists
 * @property {(dir: string) => Promise<void>} makePrivateDir
 * @property {(dir: string) => Promise<void>} remove
 * @property {(socketDir: string, port: number, sql: string) => Promise<Array<Record<string, unknown>>>} queryRestored
 * @property {(sql: string) => Promise<Array<Record<string, unknown>>>} queryLive
 */

/** @param {string} dataRoot */
export function restoreRoot(dataRoot) {
  return path.posix.join(dataRoot, "restore-test");
}

/** Stops and deletes whatever an earlier, interrupted run left. @param {RestoreHost} host @param {string} root */
export async function cleanLeftovers(host, root) {
  const names = (await host.list(root).catch(() => [])).filter((name) => /^[0-9a-f-]{36}$/.test(name));
  for (const name of names) {
    const dir = path.posix.join(root, name);
    if (await host.exists(path.posix.join(dir, "pgdata", "postmaster.pid"))) {
      await host.pgCtl(["stop", "-D", path.posix.join(dir, "pgdata"), "-m", "immediate", "-w", "-t", "60"]).catch(() => undefined);
    }
    await host.remove(dir);
  }
  return names.length;
}

/** The newest backup pgBackRest reports. @param {RestoreHost} host */
export async function newestBackup(host) {
  const { code, stdout } = await host.pgbackrest(["--output=json", "info"]);
  if (code !== 0) throw new RestoreTestError("BACKUP_INFO", "pgBackRest could not list the backups.");
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new RestoreTestError("BACKUP_INFO", "pgBackRest's backup list could not be read.");
  }
  const backups = info?.[0]?.backup ?? [];
  const last = backups[backups.length - 1];
  if (!last || !LABEL.test(String(last.label ?? ""))) throw new RestoreTestError("NO_BACKUP", "There is no backup to test yet.");
  return { label: String(last.label), sizeBytes: Number(last.info?.size ?? 0), stoppedAt: last.timestamp?.stop ? new Date(last.timestamp.stop * 1000).toISOString() : null };
}

/**
 * @param {{ host: RestoreHost, id: string, dataRoot: string, liveWalDir: string, restoreCommand?: string|null }} options
 * @returns {Promise<{ status: "passed"|"failed"|"skipped", backupLabel: string|null, checks: Record<string, unknown>, errorCode: string|null, errorMessage: string|null }>}
 */
export async function runRestoreTest({ host, id, dataRoot, liveWalDir, restoreCommand = null }) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid restore test id");
  const root = restoreRoot(dataRoot);
  const dir = path.posix.join(root, id);
  const pgdata = path.posix.join(dir, "pgdata");
  const socketDir = path.posix.join(dir, "socket");
  const checks = { cleanedLeftovers: await cleanLeftovers(host, root) };
  let backupLabel = null;
  let started = false;
  try {
    const backup = await newestBackup(host);
    backupLabel = backup.label;
    checks.backupStoppedAt = backup.stoppedAt;

    const walBytes = await host.directorySize(liveWalDir).catch(() => 0);
    const needed = Math.ceil(backup.sizeBytes * DISK_FACTOR + walBytes);
    const { freeBytes } = await host.freeSpace(dataRoot);
    checks.disk = { neededBytes: needed, freeBytes };
    if (freeBytes < needed) {
      return {
        status: "skipped",
        backupLabel,
        checks,
        errorCode: "DISK_SPACE",
        errorMessage: `Not enough free disk for a restore test: ${Math.ceil(needed / 1e9)} GB needed, ${Math.floor(freeBytes / 1e9)} GB free.`,
      };
    }

    await host.makePrivateDir(dir);
    await host.makePrivateDir(socketDir);
    const restored = await host.pgbackrest([
      `--set=${backup.label}`, `--pg1-path=${pgdata}`, "--type=immediate", "--target-action=promote", "--archive-mode=off",
      // /var/spool/pgbackrest belongs to root in the image; the test needs only an empty, private spool.
      `--spool-path=${path.posix.join(dir, "spool")}`,
      ...(restoreCommand ? [`--recovery-option=restore_command=${restoreCommand}`] : []), "restore",
    ]);
    if (restored.code !== 0) throw new RestoreTestError("RESTORE_FAILED", "pgBackRest could not restore the newest backup (the backup may be damaged).");

    const options = [
      `-c port=${TEMP_PORT}`, "-c listen_addresses=''", `-c unix_socket_directories='${socketDir}'`, "-c archive_mode=off",
      "-c logging_collector=off", "-c shared_buffers=32MB", "-c ssl=off",
      // max_connections, max_wal_senders, max_worker_processes and friends keep the restored values:
      // recovery refuses settings lower than the server the backup came from. No TCP listener, so the
      // replication slots it allows are unreachable anyway.
    ].join(" ");
    const start = await host.pgCtl(["start", "-D", pgdata, "-w", "-t", "900", "-l", path.posix.join(dir, "postgres.log"), "-o", options]);
    if (start.code !== 0) throw new RestoreTestError("START_FAILED", "The restored database did not start.");
    started = true;

    const restoredLedger = await host.queryRestored(socketDir, TEMP_PORT, "select filename, applied_at from public.polynovea_migration_ledger order by filename");
    const liveLedger = await host.queryLive("select filename, applied_at from public.polynovea_migration_ledger order by filename");
    const restoredFiles = new Set(restoredLedger.map((row) => String(row.filename)));
    const extra = [...restoredFiles].filter((file) => !liveLedger.some((row) => String(row.filename) === file));
    const backupTime = backup.stoppedAt ? Date.parse(backup.stoppedAt) : Number.POSITIVE_INFINITY;
    const missing = liveLedger.filter((row) => !restoredFiles.has(String(row.filename)) && Date.parse(String(row.applied_at)) <= backupTime);
    checks.ledger = { restored: restoredFiles.size, live: liveLedger.length, notLive: extra.length, missingBeforeBackup: missing.length };
    if (!restoredFiles.size || extra.length || missing.length) {
      throw new RestoreTestError("LEDGER_MISMATCH", "The restored migration ledger does not match the live database.");
    }

    const counts = {};
    const empty = [];
    for (const table of CORE_TABLES) {
      const sql = `select count(*)::bigint as n from public.${table}`;
      const [restoredRow] = await host.queryRestored(socketDir, TEMP_PORT, sql).catch(() => [{ n: null }]);
      const [liveRow] = await host.queryLive(sql).catch(() => [{ n: null }]);
      const restoredCount = restoredRow?.n == null ? null : Number(restoredRow.n);
      const liveCount = liveRow?.n == null ? null : Number(liveRow.n);
      counts[table] = { restored: restoredCount, live: liveCount };
      if (liveCount && !restoredCount) empty.push(table);
    }
    checks.rowCounts = counts;
    if (empty.length) throw new RestoreTestError("ROWS_MISSING", `The restored copy has no rows in ${empty.join(", ")}.`);
    return { status: "passed", backupLabel, checks, errorCode: null, errorMessage: null };
  } catch (error) {
    if (error instanceof RestoreTestError) return { status: "failed", backupLabel, checks, errorCode: error.code, errorMessage: error.message };
    return { status: "failed", backupLabel, checks, errorCode: "UNEXPECTED", errorMessage: "The restore test stopped with an unexpected error; see the server log." };
  } finally {
    if (started) await host.pgCtl(["stop", "-D", pgdata, "-m", "fast", "-w", "-t", "120"]).catch(() => undefined);
    await host.remove(dir).catch(() => undefined);
  }
}

/**
 * Whether the worker should start a restore test now.
 * @param {{ lastPassedAt: string|null, lastAttemptAt: string|null, dueMarker: boolean, now?: number }} state
 */
export function restoreTestDue({ lastPassedAt, lastAttemptAt, dueMarker, now = Date.now() }) {
  const DAY = 86_400_000;
  if (lastAttemptAt && now - Date.parse(lastAttemptAt) < DAY) return null; // at most one attempt a day
  if (dueMarker) return "first_backup";
  if (!lastPassedAt || now - Date.parse(lastPassedAt) >= 30 * DAY) return "monthly";
  return null;
}
