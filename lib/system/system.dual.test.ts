import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";

// Migration 0077 against a real database (npm run test:dual): what polynovea_app may do with the
// system tables, the four functions' rules, and the audit trail of an upgrade's steps.

const { beginRestoreTest, finishRestoreTest, listRestoreTests, listUpgrades, recordUpgradeProgress, requestUpgrade, UpgradeInProgressError, workerHeartbeat } = await import("./systemData");
const { getDb } = await import("@/lib/db/index");
const { sql } = await import("kysely");

async function closeOpenUpgrades() {
  // Tests share one database; close anything another test left open (as the owner).
  await sql`update public.system_upgrades set status = 'failed', finished_at = now() where status in ('requested', 'running')`.execute(getDb()).catch(() => undefined);
}

describeWithDatabase("system operations (migration 0077)", (db) => {
  describe("access", () => {
    it("polynovea_app reads the system tables but cannot write them directly", async () => {
      const rows = await db.query<{ relname: string; can_select: boolean; can_write: boolean }>(`
        select c.relname,
          has_table_privilege('polynovea_app', c.oid, 'select') as can_select,
          has_table_privilege('polynovea_app', c.oid, 'insert') or has_table_privilege('polynovea_app', c.oid, 'update')
            or has_table_privilege('polynovea_app', c.oid, 'delete') or has_table_privilege('polynovea_app', c.oid, 'truncate') as can_write
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('system_upgrades', 'system_restore_tests') order by 1`);
      expect(rows).toEqual([
        { relname: "system_restore_tests", can_select: true, can_write: false },
        { relname: "system_upgrades", can_select: true, can_write: false },
      ]);
      const [heartbeat] = await db.query<{ ok: boolean }>("select has_column_privilege('polynovea_app', 'public.cms_runtime_state', 'worker_heartbeat_at', 'update') as ok");
      expect(heartbeat.ok).toBe(true);
    });

    it("the four functions run for polynovea_app only, never PUBLIC, anon, authenticated or service_role", async () => {
      const rows = await db.query<{ name: string; app: boolean; public_execute: boolean; others: string[] }>(`
        select p.proname as name,
          has_function_privilege('polynovea_app', p.oid, 'execute') as app,
          exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
          array(select r.rolname::text from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.oid, p.oid, 'execute')) as others
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'polynovea_system_%' order by 1`);
      expect(rows.map((row) => row.name)).toEqual(["polynovea_system_restore_test_begin", "polynovea_system_restore_test_finish", "polynovea_system_upgrade_record", "polynovea_system_upgrade_request"]);
      for (const row of rows) expect(row).toMatchObject({ app: true, public_execute: false, others: [] });
    });
  });

  describe("upgrades", () => {
    it("allows one open upgrade, moves status forward only, and audits each step once", async () => {
      await closeOpenUpgrades();
      const { workspaceId, adminUserId } = await db.createWorkspace();
      void workspaceId;
      const requestId = randomUUID();
      await requestUpgrade({ requestId, fromRelease: "0.4.0+aaaaaaa", toRelease: "0.4.1+bbbbbbb", toVersion: "0.4.1", rollbackMode: "compatible", requestedBy: adminUserId });
      await expect(requestUpgrade({ requestId: randomUUID(), fromRelease: null, toRelease: "0.4.1+bbbbbbb", toVersion: "0.4.1", rollbackMode: "compatible", requestedBy: adminUserId })).rejects.toBeInstanceOf(UpgradeInProgressError);

      const steps = [
        { step: "verify", outcome: "ok" as const, at: "2026-11-24T00:00:01Z" },
        { step: "backup", outcome: "ok" as const, at: "2026-11-24T00:00:02Z" },
      ];
      expect(await recordUpgradeProgress({ requestId, status: "running", steps, toDigest: null })).toBe(true);
      expect(await recordUpgradeProgress({ requestId, status: "running", steps, toDigest: null })).toBe(true); // read twice
      const final = [...steps, { step: "health", outcome: "ok" as const, at: "2026-11-24T00:01:00Z" }, { step: "switch", outcome: "ok" as const, at: "2026-11-24T00:01:01Z" }];
      expect(await recordUpgradeProgress({ requestId, status: "succeeded", steps: final, toDigest: `sha256:${"b".repeat(64)}` })).toBe(true);
      expect(await recordUpgradeProgress({ requestId, status: "rolled_back", steps: final, toDigest: null })).toBe(false); // final stays final
      expect(await recordUpgradeProgress({ requestId: randomUUID(), status: "running", steps: [], toDigest: null })).toBe(false);

      const [row] = (await listUpgrades(50)).filter((upgrade) => upgrade.request_id === requestId);
      expect(row).toMatchObject({ status: "succeeded", to_digest: `sha256:${"b".repeat(64)}`, rollback_mode: "compatible" });
      expect(row.steps_json).toHaveLength(4);
      expect(row.finished_at).not.toBeNull();

      const audit = await db.query<{ action: string }>("select action from platform_audit_events where entity_type = 'system' and entity_id = $1 order by created_at, action", [requestId]);
      const actions = audit.map((event) => event.action);
      expect(actions.filter((action) => action === "system.upgrade.step.verify")).toHaveLength(1);
      expect(actions.filter((action) => action === "system.upgrade.step.backup")).toHaveLength(1);
      expect(actions).toEqual(expect.arrayContaining(["system.upgrade.requested", "system.upgrade.step.health", "system.upgrade.step.switch", "system.upgrade.succeeded"]));
    });

    it("rejects malformed values at the database", async () => {
      await closeOpenUpgrades();
      const { adminUserId } = await db.createWorkspace();
      await expect(requestUpgrade({ requestId: randomUUID(), fromRelease: null, toRelease: "../etc", toVersion: "0.4.1", rollbackMode: "compatible", requestedBy: adminUserId })).rejects.toThrow();
      await expect(requestUpgrade({ requestId: randomUUID(), fromRelease: null, toRelease: "0.4.1+b", toVersion: "0.4.1", rollbackMode: "maybe" as "restore", requestedBy: adminUserId })).rejects.toThrow();
      const requestId = randomUUID();
      await requestUpgrade({ requestId, fromRelease: null, toRelease: "0.4.1+b", toVersion: "0.4.1", rollbackMode: "restore", requestedBy: adminUserId });
      await expect(recordUpgradeProgress({ requestId, status: "exploded" as "failed", steps: [], toDigest: null })).rejects.toThrow();
      await expect(recordUpgradeProgress({ requestId, status: "running", steps: [{ step: "x", outcome: "ok", at: "t", detail: "y".repeat(70_000) }], toDigest: null })).rejects.toThrow();
      await closeOpenUpgrades();
    });
  });

  describe("restore tests", () => {
    it("runs one at a time, closes an interrupted one after 6 hours, and records the result", async () => {
      await sql`update public.system_restore_tests set status = 'failed', finished_at = now() where status = 'running'`.execute(getDb());
      const id = await beginRestoreTest("manual");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await beginRestoreTest("monthly")).toBeNull();
      await db.query("update system_restore_tests set started_at = now() - interval '7 hours' where id = $1", [id]);
      const next = await beginRestoreTest("monthly");
      expect(next).not.toBeNull();
      const tests = await listRestoreTests(50);
      expect(tests.find((test) => test.id === id)).toMatchObject({ status: "failed", error_code: "INTERRUPTED" });

      expect(await finishRestoreTest({ id: next!, status: "failed", backupLabel: "20261124-020000F", checks: { ledger: { restored: 2 } }, errorCode: "RESTORE_FAILED", errorMessage: "pgBackRest could not restore the newest backup." })).toBe(true);
      expect(await finishRestoreTest({ id: next!, status: "passed", backupLabel: null, checks: {}, errorCode: null, errorMessage: null })).toBe(false);
      const [latest] = await listRestoreTests(1);
      expect(latest).toMatchObject({ id: next, status: "failed", backup_label: "20261124-020000F", checks_json: { ledger: { restored: 2 } } });
      const audit = await db.query("select 1 from platform_audit_events where action = 'system.restore_test.failed' and entity_id = $1", [next]);
      expect(audit.length).toBe(1);
    });
  });

  it("reads the worker heartbeat", async () => {
    await db.query("update cms_runtime_state set worker_heartbeat_at = now() where singleton");
    expect(Date.now() - Date.parse((await workerHeartbeat())!)).toBeLessThan(60_000);
  });
});
