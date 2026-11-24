import { describe, expect, it } from "vitest";
import advisoryFile from "./advisories.json";
import { authAdvisoryCheck, backupCheck, databaseCheck, diskCheck, inRange, migrationsCheck, restoreTestCheck, tlsCheck, workerCheck, type Advisory } from "./doctorChecks";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

describe("System Doctor checks: one pass and one fail case each", () => {
  it("database", async () => {
    expect((await databaseCheck(async () => undefined)).severity).toBe("ok");
    const failed = await databaseCheck(async () => { throw new Error("connect ECONNREFUSED postgresql://u:p@h/db"); });
    expect(failed.severity).toBe("blocking");
    expect(failed.message).not.toMatch(/postgresql|ECONN/);
  });

  it("TLS and CA bundle", () => {
    expect(tlsCheck({ mode: "managed", ssl: true, caBundleId: "aws-rds-global-1", earliestRootExpiry: daysAgo(-400), validRoots: 4 }, NOW).severity).toBe("ok");
    expect(tlsCheck({ mode: "local" }).severity).toBe("ok");
    expect(tlsCheck({ mode: "managed", ssl: false, caBundleId: null, earliestRootExpiry: null, validRoots: 0 }, NOW).severity).toBe("blocking");
    expect(tlsCheck({ mode: "managed", ssl: true, caBundleId: "aws-rds-global-1", earliestRootExpiry: daysAgo(-30), validRoots: 4 }, NOW)).toMatchObject({ severity: "warning", message: expect.stringContaining("30 days") });
    expect(tlsCheck({ mode: "managed", ssl: true, caBundleId: "aws-rds-global-1", earliestRootExpiry: null, validRoots: 0 }, NOW).severity).toBe("blocking");
  });

  it("disk (alert at 80%)", () => {
    expect(diskCheck({ usedFraction: 0.42, freeBytes: 20e9 }).severity).toBe("ok");
    expect(diskCheck({ usedFraction: 0.8, freeBytes: 4e9 })).toMatchObject({ severity: "warning", message: expect.stringContaining("80%") });
    expect(diskCheck({ usedFraction: 0.96, freeBytes: 1e9 }).severity).toBe("blocking");
    expect(diskCheck(null).severity).toBe("warning");
  });

  it("backup age", () => {
    expect(backupCheck({ kind: "pgbackrest", lastBackupAt: hoursAgo(5) }, NOW).severity).toBe("ok");
    expect(backupCheck({ kind: "pgbackrest", lastBackupAt: hoursAgo(30) }, NOW)).toMatchObject({ severity: "blocking", message: expect.stringContaining("30 hours") });
    expect(backupCheck({ kind: "pgbackrest", lastBackupAt: null }, NOW).severity).toBe("blocking");
    expect(backupCheck({ kind: "pgbackrest", lastBackupAt: null, error: true }, NOW).severity).toBe("blocking");
    expect(backupCheck({ kind: "none" }, NOW).severity).toBe("blocking");
  });

  it("cloud backup retention (managed databases)", () => {
    expect(backupCheck({ kind: "managed", retentionDays: 7 }, NOW).severity).toBe("ok");
    expect(backupCheck({ kind: "managed", retentionDays: null }, NOW)).toMatchObject({ severity: "ok", message: expect.stringContaining("cloud console") });
    expect(backupCheck({ kind: "managed", retentionDays: 3 }, NOW).severity).toBe("warning");
  });

  it("last restore test", () => {
    const passed = { status: "passed" as const, startedAt: daysAgo(3), finishedAt: daysAgo(3), errorMessage: null };
    expect(restoreTestCheck(passed, daysAgo(3), true, NOW).severity).toBe("ok");
    expect(restoreTestCheck({ ...passed, status: "failed", errorMessage: "pgBackRest reported a checksum error" }, daysAgo(40), true, NOW)).toMatchObject({ severity: "blocking", message: expect.stringContaining("checksum") });
    expect(restoreTestCheck(passed, daysAgo(40), true, NOW).severity).toBe("warning");
    expect(restoreTestCheck(null, null, true, NOW).severity).toBe("warning");
    expect(restoreTestCheck({ ...passed, status: "skipped", errorMessage: "not enough free disk" }, daysAgo(3), true, NOW).severity).toBe("warning");
    expect(restoreTestCheck(null, null, false, NOW).severity).toBe("ok");
  });

  it("pending migrations", () => {
    expect(migrationsCheck(["0076_a.sql", "0077_b.sql"], ["0076_a.sql", "0077_b.sql"]).severity).toBe("ok");
    expect(migrationsCheck(["0076_a.sql", "0077_b.sql"], ["0076_a.sql"])).toMatchObject({ severity: "blocking", evidence: { pending: ["0077_b.sql"] } });
  });

  it("worker heartbeat", () => {
    expect(workerCheck(new Date(NOW - 30_000).toISOString(), NOW).severity).toBe("ok");
    expect(workerCheck(new Date(NOW - 600_000).toISOString(), NOW).severity).toBe("blocking");
    expect(workerCheck(null, NOW).severity).toBe("blocking");
  });

  it("auth library against known advisories", () => {
    const advisories: Advisory[] = [
      { id: "GHSA-test-0001", package: "better-auth", affected: ">=1.6.0 <1.7.28", fixed: "1.7.28", severity: "high", summary: "x", url: "https://example.com/a" },
      { id: "GHSA-test-0002", package: "@better-auth/passkey", affected: "<1.0.0", fixed: "1.0.0", severity: "low", summary: "y", url: "https://example.com/b" },
    ];
    expect(authAdvisoryCheck({ "better-auth": "1.7.28", "@better-auth/passkey": "1.7.28" }, advisories).severity).toBe("ok");
    const hit = authAdvisoryCheck({ "better-auth": "1.7.27", "@better-auth/passkey": "1.7.27" }, advisories);
    expect(hit).toMatchObject({ severity: "blocking", message: expect.stringContaining("GHSA-test-0001") });
    expect(authAdvisoryCheck({ "better-auth": "1.7.28", "@better-auth/passkey": "0.9.0" }, advisories).severity).toBe("warning");
    expect(authAdvisoryCheck({ "better-auth": null }, advisories).severity).toBe("warning");
  });

  it("advisory ranges and the shipped list", () => {
    expect(inRange("1.7.27", ">=1.6.0 <1.7.28")).toBe(true);
    expect(inRange("1.7.28", ">=1.6.0 <1.7.28")).toBe(false);
    expect(inRange("1.8.0-beta.1", "<1.8.0")).toBe(true);
    expect(() => inRange("1.0.0", "^1.0.0")).toThrow();
    expect(advisoryFile.schema).toBe(1);
    for (const advisory of advisoryFile.advisories as Advisory[]) {
      expect(advisoryFile.packages).toContain(advisory.package);
      expect(() => inRange("0.0.0", advisory.affected)).not.toThrow();
      expect(advisory.url).toMatch(/^https:\/\//);
    }
  });
});
