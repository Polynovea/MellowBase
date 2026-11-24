import { describe, expect, it } from "vitest";
import { cleanLeftovers, restoreTestDue, runRestoreTest, type RestoreHost } from "./restoreTest.mjs";

const ID = "0f0e0d0c-0b0a-4909-8807-060504030201";
const OLD = "11111111-2222-4333-8444-555555555555";
const BACKUP_STOP = Date.parse("2026-11-24T02:00:00Z") / 1000;
const LEDGER = [
  { filename: "0076_content_tables_move.sql", applied_at: "2026-11-20T00:00:00Z" },
  { filename: "0077_system_operations.sql", applied_at: "2026-11-21T00:00:00Z" },
];

function fakeHost(overrides: Partial<RestoreHost> & { freeBytes?: number; restoreCode?: number; restoredLedger?: typeof LEDGER; restoredCounts?: number; leftovers?: string[] } = {}) {
  const calls: string[] = [];
  const removed: string[] = [];
  const host: RestoreHost = {
    async pgbackrest(args) {
      calls.push(`pgbackrest ${args.join(" ")}`);
      if (args.includes("info")) return { code: 0, stdout: JSON.stringify([{ backup: [{ label: "20261124-020000F", info: { size: 1e9 }, timestamp: { stop: BACKUP_STOP } }] }]) };
      return { code: overrides.restoreCode ?? 0, stdout: "" };
    },
    async pgCtl(args) {
      calls.push(`pg_ctl ${args.slice(0, 3).join(" ")}`);
      return { code: 0 };
    },
    freeSpace: async () => ({ freeBytes: overrides.freeBytes ?? 50e9 }),
    directorySize: async () => 64e6,
    list: async () => overrides.leftovers ?? [],
    exists: async (file) => file.includes(OLD),
    makePrivateDir: async (dir) => void calls.push(`mkdir ${dir}`),
    remove: async (dir) => void removed.push(dir),
    queryRestored: async (_socket, port, sql) => {
      calls.push(`restored:${port}`);
      return sql.includes("ledger") && !sql.includes("count") ? overrides.restoredLedger ?? LEDGER : [{ n: overrides.restoredCounts ?? 7 }];
    },
    queryLive: async (sql) => (sql.includes("ledger") && !sql.includes("count") ? LEDGER : [{ n: 7 }]),
    ...overrides,
  };
  return { host, calls, removed };
}

const RESTORE_COMMAND = (pg1: string) => `pgbackrest --config="/var/lib/polynovea/etc/pgbackrest.conf" --pg1-path="${pg1}" --stanza=polynovea archive-get %f "%p"`;
const run = (host: RestoreHost) =>
  runRestoreTest({ host, id: ID, dataRoot: "/var/lib/polynovea", liveWalDir: "/var/lib/polynovea/postgresql/pg_wal", restoreCommand: RESTORE_COMMAND });

describe("restore test", () => {
  it("passes on a healthy backup: restores without archiving, checks ledger and rows, and always cleans up", async () => {
    const { host, calls, removed } = fakeHost();
    const result = await run(host);
    expect(result).toMatchObject({ status: "passed", backupLabel: "20261124-020000F", errorCode: null });
    expect(result.checks).toMatchObject({ ledger: { restored: 2, live: 2, notLive: 0, missingBeforeBackup: 0 }, rowCounts: { workspaces: { restored: 7, live: 7, liveBeforeBackup: 7 } } });
    const restore = calls.find((line) => line.includes(" restore"))!;
    expect(restore).toContain("--set=20261124-020000F");
    expect(restore).toContain("--archive-mode=off");
    expect(restore).toContain(`--spool-path=/var/lib/polynovea/restore-test/${ID}/spool`);
    // The temporary cluster's own folder, or archive-get refuses to fetch WAL for it.
    expect(restore).toContain(`--recovery-option=restore_command=${RESTORE_COMMAND(`/var/lib/polynovea/restore-test/${ID}/pgdata`)}`);
    expect(restore).toContain(`--pg1-path=/var/lib/polynovea/restore-test/${ID}/pgdata`);
    expect(calls).toContain(`pg_ctl stop -D /var/lib/polynovea/restore-test/${ID}/pgdata`);
    expect(removed).toEqual([`/var/lib/polynovea/restore-test/${ID}`]);
  });

  it("fails (an alert) on a corrupt backup pgBackRest cannot restore, and still cleans up", async () => {
    const { host, calls, removed } = fakeHost({ restoreCode: 1 });
    const result = await run(host);
    expect(result).toMatchObject({ status: "failed", errorCode: "RESTORE_FAILED" });
    expect(calls.some((line) => line.startsWith("pg_ctl start"))).toBe(false);
    expect(removed).toEqual([`/var/lib/polynovea/restore-test/${ID}`]);
  });

  it("fails when the restored ledger is missing a migration applied before the backup, or rows that existed then", async () => {
    expect(await run(fakeHost({ restoredLedger: LEDGER.slice(0, 1) }).host)).toMatchObject({ status: "failed", errorCode: "LEDGER_MISMATCH" });
    // 7 rows live, all made before the backup; only 5 restored.
    const short = await run(fakeHost({ restoredCounts: 5, queryLive: async (sql) => (sql.includes("ledger") && !sql.includes("count") ? LEDGER : [{ n: 7 }]) }).host);
    expect(short).toMatchObject({ status: "failed", errorCode: "ROWS_MISSING" });
  });

  it("does not expect rows made after the backup (the installation row written after setup's first backup)", async () => {
    const queryLive = async (sql: string) => {
      if (sql.includes("ledger") && !sql.includes("count")) return LEDGER;
      if (sql.includes("from public.installation")) return [{ n: sql.includes("<=") ? 0 : 1 }];
      return [{ n: sql.includes("<=") ? 5 : 7 }];
    };
    const queryRestored = async (_socket: string, _port: number, sql: string) =>
      sql.includes("ledger") && !sql.includes("count") ? LEDGER : [{ n: sql.includes("installation") ? 0 : 5 }];
    const result = await run(fakeHost({ queryLive, queryRestored }).host);
    expect(result).toMatchObject({ status: "passed", checks: { rowCounts: { installation: { restored: 0, live: 1, liveBeforeBackup: 0 } } } });
    expect(String((await (async () => { const calls: string[] = []; await run(fakeHost({ queryLive: async (sql) => { calls.push(sql); return queryLive(sql); }, queryRestored }).host); return calls.find((c) => c.includes("<=")); })()))).toContain("<= '2026-11-24T02:00:00.000Z'::timestamptz");
  });

  it("accepts live migrations applied after the backup", async () => {
    const later = [...LEDGER, { filename: "0078_later.sql", applied_at: "2026-11-24T05:00:00Z" }];
    const { host } = fakeHost({ queryLive: async (sql) => (sql.includes("ledger") && !sql.includes("count") ? later : [{ n: 7 }]) });
    expect(await run(host)).toMatchObject({ status: "passed" });
  });

  it("keeps the temporary server's log tail when it does not start", async () => {
    const { host, removed } = fakeHost({
      pgCtl: async (args) => ({ code: args[0] === "start" ? 1 : 0 }),
      readTail: async () => "FATAL:  hot standby is not possible because of insufficient parameter settings",
    });
    const result = await run(host);
    expect(result).toMatchObject({ status: "failed", errorCode: "START_FAILED", checks: { startLog: expect.stringContaining("insufficient parameter") } });
    expect(removed).toEqual([`/var/lib/polynovea/restore-test/${ID}`]);
  });

  it("skips with a warning instead of filling the disk", async () => {
    const { host, calls, removed } = fakeHost({ freeBytes: 1e9 });
    const result = await run(host);
    expect(result).toMatchObject({ status: "skipped", errorCode: "DISK_SPACE" });
    expect(result.errorMessage).toMatch(/2 GB needed, 1 GB free/);
    expect(calls.some((line) => line.includes(" restore"))).toBe(false);
    expect(removed).toEqual([`/var/lib/polynovea/restore-test/${ID}`]);
  });

  it("cleans up what a killed run left, stopping its PostgreSQL first", async () => {
    const { host, calls, removed } = fakeHost({ leftovers: [OLD, "not-a-test-folder"] });
    expect(await cleanLeftovers(host, "/var/lib/polynovea/restore-test")).toBe(1);
    expect(calls).toContain(`pg_ctl stop -D /var/lib/polynovea/restore-test/${OLD}/pgdata`);
    expect(removed).toEqual([`/var/lib/polynovea/restore-test/${OLD}`]);
  });

  it("is due monthly, after the first backup, and at most once a day", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    expect(restoreTestDue({ lastPassedAt: ago(3), lastAttemptAt: ago(3), dueMarker: false, now })).toBeNull();
    expect(restoreTestDue({ lastPassedAt: ago(31), lastAttemptAt: ago(31), dueMarker: false, now })).toBe("monthly");
    expect(restoreTestDue({ lastPassedAt: null, lastAttemptAt: null, dueMarker: true, now })).toBe("first_backup");
    expect(restoreTestDue({ lastPassedAt: null, lastAttemptAt: ago(0.5), dueMarker: true, now })).toBeNull();
  });
});
