import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import { getDb } from "@/lib/db/index";
import { listMigrationFiles } from "@/scripts/run-migrations.mjs";
import { readConfigSync } from "@/lib/setup/configStore";
import { certificateAuthoritiesFor } from "@/lib/setup/database/caBundles";
import { imagePaths, imagePgBackRestEnv, runningInServerImage } from "@/lib/setup/database/localServerImage";
import advisoryFile from "./advisories.json";
import {
  authAdvisoryCheck,
  backupCheck,
  databaseCheck,
  diskCheck,
  migrationsCheck,
  restoreTestCheck,
  tlsCheck,
  workerCheck,
  type Advisory,
  type BackupState,
  type CheckResult,
  type TlsState,
} from "./doctorChecks";
import { listRestoreTests, workerHeartbeat } from "./systemData";

/**
 * The real probes behind the System Doctor checks (doctorChecks.ts). Each probe catches its own
 * errors and reports a plain state; none returns driver text, connection strings or file contents.
 */

type Env = Record<string, string | undefined>;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const STANZA = "polynovea";

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref?.())]);

export async function probeDatabase(): Promise<void> {
  await withTimeout(sql`select 1`.execute(getDb()), 5_000);
}

function databaseHost(env: Env): { host: string | null; caBundleId: string | null } {
  try {
    const config = readConfigSync(env);
    if (config) return { host: config.database.host, caBundleId: config.database.caBundleId ?? null };
  } catch {
    return { host: null, caBundleId: null };
  }
  const url = env.POLYNOVEA_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) return { host: null, caBundleId: null };
  try {
    return { host: new URL(url).hostname, caBundleId: null };
  } catch {
    return { host: null, caBundleId: null };
  }
}

export async function probeTls(env: Env = process.env): Promise<TlsState> {
  const { host, caBundleId } = databaseHost(env);
  if (!host || LOOPBACK.test(host)) return { mode: "local" };
  let ssl = false;
  try {
    const { rows } = await sql<{ ssl: boolean }>`select ssl from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()`.execute(getDb());
    ssl = rows[0]?.ssl === true;
  } catch {
    ssl = false;
  }
  let earliest: number | null = null;
  let valid = 0;
  const roots = caBundleId ? certificateAuthoritiesFor(caBundleId) : null;
  if (caBundleId && caBundleId.startsWith("aws-rds") && Array.isArray(roots)) {
    for (const pem of roots as string[]) {
      try {
        const expires = Date.parse(new X509Certificate(pem).validTo);
        if (expires > Date.now()) {
          valid += 1;
          earliest = earliest === null ? expires : Math.min(earliest, expires);
        }
      } catch {
        // not a certificate; ignored
      }
    }
  } else {
    valid = Array.isArray(roots) ? roots.length : 0;
  }
  return { mode: "managed", ssl, caBundleId, earliestRootExpiry: earliest === null ? null : new Date(earliest).toISOString(), validRoots: caBundleId ? valid : 1 };
}

export async function probeDisk(env: Env = process.env): Promise<{ usedFraction: number; freeBytes: number } | null> {
  try {
    const stats = await fs.statfs(env.POLYNOVEA_DATA_ROOT?.trim() || imagePaths(env).dataRoot);
    if (!stats.blocks) return null;
    return { usedFraction: 1 - stats.bavail / stats.blocks, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

export async function databaseMode(): Promise<"local" | "managed" | null> {
  try {
    const row = await getDb().selectFrom("installation").select("database_mode").executeTakeFirst();
    if (!row) return null;
    return row.database_mode === "local" ? "local" : "managed";
  } catch {
    return null;
  }
}

/** pgBackRest's own report of the newest backup's finish time. */
export function pgBackRestInfo(env: Env = process.env): Promise<{ lastBackupAt: string | null; error?: boolean; sizeBytes?: number }> {
  const paths = imagePaths(env);
  return new Promise((resolve) => {
    execFile("pgbackrest", [`--stanza=${STANZA}`, "--output=json", "info"], { timeout: 60_000, encoding: "utf8", env: { ...imagePgBackRestEnv(paths), PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv }, (error, stdout) => {
      if (error) return resolve({ lastBackupAt: null, error: true });
      try {
        const [stanza] = JSON.parse(stdout) as Array<{ backup?: Array<{ timestamp?: { stop?: number }; info?: { size?: number } }> }>;
        const backups = stanza?.backup ?? [];
        const last = backups[backups.length - 1];
        resolve({ lastBackupAt: last?.timestamp?.stop ? new Date(last.timestamp.stop * 1000).toISOString() : null, sizeBytes: last?.info?.size });
      } catch {
        resolve({ lastBackupAt: null, error: true });
      }
    });
  });
}

export async function probeBackup(mode: "local" | "managed" | null, env: Env = process.env): Promise<BackupState> {
  if (mode === "managed") {
    const days = Number(env.POLYNOVEA_CLOUD_BACKUP_RETENTION_DAYS);
    return { kind: "managed", retentionDays: Number.isFinite(days) && days > 0 ? days : null };
  }
  if (mode === "local" && runningInServerImage(env)) {
    const info = await pgBackRestInfo(env);
    return { kind: "pgbackrest", lastBackupAt: info.lastBackupAt, error: info.error };
  }
  return mode === "local" ? { kind: "pgbackrest", lastBackupAt: null, error: true } : { kind: "none" };
}

export async function probeMigrations(): Promise<{ shipped: string[]; applied: string[] } | null> {
  try {
    const shipped = listMigrationFiles().map((file: string) => path.basename(file));
    const { rows } = await sql<{ filename: string }>`select filename from public.polynovea_migration_ledger`.execute(getDb());
    return { shipped, applied: rows.map((row) => path.basename(row.filename)) };
  } catch {
    return null;
  }
}

export async function installedVersions(packages: readonly string[], root = process.cwd()): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const name of packages) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "node_modules", ...name.split("/"), "package.json"), "utf8"));
      result[name] = typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      result[name] = null;
    }
  }
  return result;
}

/** Runs every system check. Never throws; a check whose probe fails reports that as its finding. */
export async function runSystemChecks(env: Env = process.env): Promise<CheckResult[]> {
  const mode = await databaseMode();
  const [database, tls, disk, backup, restoreTests, migrations, heartbeat, versions] = await Promise.all([
    databaseCheck(probeDatabase),
    probeTls(env).then((state) => tlsCheck(state)),
    probeDisk(env).then(diskCheck),
    probeBackup(mode, env).then((state) => backupCheck(state)),
    listRestoreTests(20).catch(() => []),
    probeMigrations(),
    workerHeartbeat().catch(() => null),
    installedVersions(advisoryFile.packages),
  ]);
  const latest = restoreTests[0] ?? null;
  const lastPassed = restoreTests.find((row) => row.status === "passed") ?? null;
  return [
    database,
    tls,
    disk,
    backup,
    restoreTestCheck(latest && { status: latest.status, startedAt: latest.started_at, finishedAt: latest.finished_at, errorMessage: latest.error_message }, lastPassed?.finished_at ?? null, mode === "local"),
    migrations ? migrationsCheck(migrations.shipped, migrations.applied) : { key: "system.migrations", severity: "warning", message: "The migration ledger could not be read." },
    workerCheck(heartbeat),
    authAdvisoryCheck(versions, advisoryFile.advisories as Advisory[]),
  ];
}
