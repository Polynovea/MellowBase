import { compareVersions } from "./releaseChannel";

/**
 * System Doctor checks for a self-hosted install (design: "Operations → Health"). Each check is a
 * small function over a probe, so each has a pass case and a fail case in doctorChecks.test.ts; the
 * probes that touch the database, the disk and pgBackRest are in systemProbes.ts.
 *
 * Results feed runSystemDoctor (lib/infrastructure/operabilityService.ts) as `system.*` findings and
 * the System page. Messages are plain and never carry connection strings or paths with secrets.
 */

export type Severity = "ok" | "info" | "warning" | "blocking";

export interface CheckResult {
  key: string;
  severity: Severity;
  message: string;
  evidence?: Record<string, unknown>;
}

const DAY = 86_400_000;
const days = (ms: number) => Math.floor(ms / DAY);

export const THRESHOLDS = {
  diskWarning: 0.8,
  diskBlocking: 0.95,
  backupMaxAgeHours: 26,
  restoreTestMaxAgeDays: 35,
  workerHeartbeatMaxSeconds: 120,
  certificateWarningDays: 90,
  cloudBackupMinRetentionDays: 7,
} as const;

export async function databaseCheck(probe: () => Promise<void>): Promise<CheckResult> {
  try {
    await probe();
    return { key: "system.database", severity: "ok", message: "The database answers." };
  } catch {
    return { key: "system.database", severity: "blocking", message: "The database did not answer within 5 seconds." };
  }
}

export type TlsState =
  | { mode: "local" }
  | { mode: "managed"; ssl: boolean; caBundleId: string | null; earliestRootExpiry: string | null; validRoots: number };

export function tlsCheck(state: TlsState, now = Date.now()): CheckResult {
  const key = "system.tls";
  if (state.mode === "local") return { key, severity: "ok", message: "The database is on this server (loopback); no TLS needed." };
  if (!state.ssl) return { key, severity: "blocking", message: "The connection to the managed database is not encrypted." };
  if (state.caBundleId && state.validRoots === 0) {
    return { key, severity: "blocking", message: "Every certificate in the database's CA bundle has expired. Upgrade to a release with a refreshed bundle.", evidence: { caBundleId: state.caBundleId } };
  }
  if (state.earliestRootExpiry) {
    const left = days(Date.parse(state.earliestRootExpiry) - now);
    if (left < THRESHOLDS.certificateWarningDays) {
      return { key, severity: "warning", message: `A certificate in the database's CA bundle expires in ${left} days. A release with a refreshed bundle is needed before then.`, evidence: { caBundleId: state.caBundleId, expires: state.earliestRootExpiry } };
    }
  }
  return { key, severity: "ok", message: "The database connection is encrypted and verified; the CA bundle is current.", evidence: { caBundleId: state.caBundleId } };
}

export function diskCheck(usage: { usedFraction: number; freeBytes: number } | null): CheckResult {
  const key = "system.disk";
  if (!usage) return { key, severity: "warning", message: "Disk space on the data disk could not be read." };
  const percent = Math.round(usage.usedFraction * 100);
  const evidence = { usedPercent: percent, freeGb: Math.round((usage.freeBytes / 1e9) * 10) / 10 };
  if (usage.usedFraction >= THRESHOLDS.diskBlocking) return { key, severity: "blocking", message: `The data disk is ${percent}% full. Free space or grow the disk now; the database stops when it is full.`, evidence };
  if (usage.usedFraction >= THRESHOLDS.diskWarning) return { key, severity: "warning", message: `The data disk is ${percent}% full (alert at 80%).`, evidence };
  return { key, severity: "ok", message: `The data disk is ${percent}% full.`, evidence };
}

export type BackupState =
  | { kind: "pgbackrest"; lastBackupAt: string | null; error?: boolean }
  | { kind: "managed"; retentionDays: number | null }
  | { kind: "none" };

export function backupCheck(state: BackupState, now = Date.now()): CheckResult {
  const key = "system.backup";
  if (state.kind === "managed") {
    if (state.retentionDays !== null && state.retentionDays < THRESHOLDS.cloudBackupMinRetentionDays) {
      return { key, severity: "warning", message: `The cloud database keeps backups for ${state.retentionDays} days; 7 or more is recommended.`, evidence: { retentionDays: state.retentionDays } };
    }
    return {
      key,
      severity: "ok",
      message: state.retentionDays === null
        ? "Backups are the cloud database's automated backups. Check their retention (7 days or more) in the cloud console."
        : `Backups are the cloud database's automated backups, kept ${state.retentionDays} days.`,
      evidence: { retentionDays: state.retentionDays },
    };
  }
  if (state.kind === "none") return { key, severity: "blocking", message: "No backups are configured." };
  if (state.error) return { key, severity: "blocking", message: "pgBackRest could not report the backups." };
  if (!state.lastBackupAt) return { key, severity: "blocking", message: "No backup has been taken yet." };
  const hours = Math.floor((now - Date.parse(state.lastBackupAt)) / 3_600_000);
  if (hours > THRESHOLDS.backupMaxAgeHours) return { key, severity: "blocking", message: `The last backup is ${hours} hours old (daily backups expected).`, evidence: { lastBackupAt: state.lastBackupAt } };
  return { key, severity: "ok", message: `The last backup is ${hours} hours old.`, evidence: { lastBackupAt: state.lastBackupAt } };
}

export interface RestoreTestSummary {
  status: "running" | "passed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export function restoreTestCheck(latest: RestoreTestSummary | null, lastPassedAt: string | null, applies: boolean, now = Date.now()): CheckResult {
  const key = "system.restore_test";
  if (!applies) return { key, severity: "ok", message: "Restore tests of cloud database backups are run in the cloud console; this server tests its own backups only." };
  if (latest?.status === "failed") return { key, severity: "blocking", message: `The last restore test failed: ${latest.errorMessage ?? "see the System page"}.`, evidence: { at: latest.finishedAt ?? latest.startedAt } };
  if (latest?.status === "skipped") return { key, severity: "warning", message: `The last restore test was skipped: ${latest.errorMessage ?? "see the System page"}.`, evidence: { at: latest.finishedAt ?? latest.startedAt } };
  if (!lastPassedAt) return { key, severity: "warning", message: "No restore test has passed yet. The worker runs one after the first backup and then monthly." };
  const age = days(now - Date.parse(lastPassedAt));
  if (age > THRESHOLDS.restoreTestMaxAgeDays) return { key, severity: "warning", message: `The last passed restore test is ${age} days old (monthly expected).`, evidence: { lastPassedAt } };
  return { key, severity: "ok", message: `The last restore test passed ${age} days ago.`, evidence: { lastPassedAt } };
}

export function migrationsCheck(shipped: readonly string[], applied: readonly string[]): CheckResult {
  const key = "system.migrations";
  const done = new Set(applied);
  const pending = shipped.filter((file) => !done.has(file));
  if (pending.length) return { key, severity: "blocking", message: `${pending.length} database migration(s) are pending. Run the upgrade again or run migrations.`, evidence: { pending: pending.slice(0, 20) } };
  return { key, severity: "ok", message: `All ${shipped.length} migrations are applied.` };
}

export function workerCheck(heartbeatAt: string | null, now = Date.now()): CheckResult {
  const key = "system.worker";
  if (!heartbeatAt) return { key, severity: "blocking", message: "The background worker has never reported in." };
  const seconds = Math.floor((now - Date.parse(heartbeatAt)) / 1000);
  if (seconds > THRESHOLDS.workerHeartbeatMaxSeconds) return { key, severity: "blocking", message: `The background worker last reported ${seconds} seconds ago; scheduled publishing, webhooks and restore tests are not running.`, evidence: { heartbeatAt } };
  return { key, severity: "ok", message: "The background worker is running.", evidence: { heartbeatAt } };
}

export interface Advisory {
  id: string;
  package: string;
  /** Space-separated comparators, all of which must hold: ">=1.6.0 <1.7.28". */
  affected: string;
  fixed: string;
  severity: "low" | "moderate" | "high" | "critical";
  summary: string;
  url: string;
}

export function inRange(version: string, range: string): boolean {
  return range.trim().split(/\s+/).every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator);
    if (!match) throw new Error(`Unsupported advisory range: ${range}`);
    const order = compareVersions(version, match[2]);
    switch (match[1] ?? "=") {
      case ">=": return order >= 0;
      case "<=": return order <= 0;
      case ">": return order > 0;
      case "<": return order < 0;
      default: return order === 0;
    }
  });
}

export function authAdvisoryCheck(installed: Record<string, string | null>, advisories: readonly Advisory[]): CheckResult {
  const key = "system.auth_advisories";
  const hits = advisories.filter((advisory) => {
    const version = installed[advisory.package];
    return Boolean(version) && inRange(version as string, advisory.affected);
  });
  const missing = Object.entries(installed).filter(([, version]) => !version).map(([name]) => name);
  if (hits.length) {
    const worst = hits.some((hit) => hit.severity === "high" || hit.severity === "critical") ? "blocking" : "warning";
    return {
      key,
      severity: worst,
      message: `The sign-in library has ${hits.length} known advisory(ies): ${hits.map((hit) => `${hit.id} (${hit.package} ${installed[hit.package]}, fixed in ${hit.fixed})`).join("; ")}. Upgrade to a release that includes the fix.`,
      evidence: { advisories: hits.map((hit) => ({ id: hit.id, package: hit.package, installed: installed[hit.package], fixed: hit.fixed, url: hit.url })) },
    };
  }
  if (missing.length) return { key, severity: "warning", message: `The installed version of ${missing.join(", ")} could not be read.` };
  return { key, severity: "ok", message: `No known advisories for ${Object.entries(installed).map(([name, version]) => `${name} ${version}`).join(", ")}.` };
}
