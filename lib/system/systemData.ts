// PostgreSQL reads and writes for the System page: upgrades, restore tests and the worker heartbeat
// (migration 0077). The two tables are read-only for polynovea_app; every change goes through the
// migration's functions, which check each value. Audit rows go to platform_audit_events in the same
// transaction as the change they describe, under the installation's first workspace.
import { sql } from "kysely";
import { getDb, withTransaction, type DbExecutor } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UpgradeStatus = "requested" | "running" | "succeeded" | "rolled_back" | "restore_needed" | "failed";
export const FINAL_UPGRADE_STATUSES: readonly UpgradeStatus[] = ["succeeded", "rolled_back", "restore_needed", "failed"];

export interface UpgradeStep {
  step: string;
  outcome: "started" | "ok" | "failed" | "skipped";
  at: string;
  detail?: string;
}

export interface UpgradeRow {
  id: string;
  request_id: string;
  from_release: string | null;
  to_release: string;
  to_version: string;
  to_digest: string | null;
  rollback_mode: "compatible" | "restore";
  status: UpgradeStatus;
  steps_json: UpgradeStep[];
  requested_by: string | null;
  requested_at: string;
  finished_at: string | null;
}

export interface RestoreTestRow {
  id: string;
  reason: string;
  status: "running" | "passed" | "failed" | "skipped";
  backup_label: string | null;
  checks_json: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

const iso = (value: unknown): string | null => (value == null ? null : value instanceof Date ? value.toISOString() : String(value));
const parsed = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};

function upgradeRow(row: Record<string, unknown>): UpgradeRow {
  return {
    ...(row as unknown as UpgradeRow),
    steps_json: parsed<UpgradeStep[]>(row.steps_json, []),
    requested_at: iso(row.requested_at) ?? "",
    finished_at: iso(row.finished_at),
  };
}

function restoreRow(row: Record<string, unknown>): RestoreTestRow {
  return {
    ...(row as unknown as RestoreTestRow),
    checks_json: parsed<Record<string, unknown>>(row.checks_json, {}),
    started_at: iso(row.started_at) ?? "",
    finished_at: iso(row.finished_at),
  };
}

/** The workspace system-level audit rows belong to: the installation's first one. Null before setup. */
export async function systemWorkspaceId(executor: DbExecutor = getDb()): Promise<string | null> {
  const row = await executor.selectFrom("workspaces").select("id").orderBy("created_at").orderBy("id").limit(1).executeTakeFirst();
  return (row?.id as string | undefined) ?? null;
}

async function audit(executor: DbExecutor, actorId: string | null, action: string, entityId: string, metadata: Record<string, unknown>) {
  const workspaceId = await systemWorkspaceId(executor);
  if (!workspaceId) return;
  await recordPlatformEvent(executor, {
    workspaceId,
    actorAdminUserId: actorId as string,
    action,
    entityType: "system",
    entityId,
    metadata,
  });
}

export class UpgradeInProgressError extends Error {
  status = 409;
  constructor() {
    super("Another upgrade is already in progress.");
  }
}

export async function requestUpgrade(input: {
  requestId: string;
  fromRelease: string | null;
  toRelease: string;
  toVersion: string;
  rollbackMode: "compatible" | "restore";
  requestedBy: string;
}): Promise<string> {
  try {
    return await withTransaction(async (trx) => {
      const { rows } = await sql<{ id: string }>`select public.polynovea_system_upgrade_request(
        ${input.requestId}::uuid, ${input.fromRelease}, ${input.toRelease}, ${input.toVersion}, ${input.rollbackMode}, ${input.requestedBy}::uuid) as id`.execute(trx);
      await audit(trx, input.requestedBy, "system.upgrade.requested", input.requestId, {
        fromRelease: input.fromRelease,
        toRelease: input.toRelease,
        toVersion: input.toVersion,
        rollbackMode: input.rollbackMode,
      });
      return rows[0].id;
    });
  } catch (error) {
    if (/another upgrade is in progress|system_upgrades_one_open/.test((error as Error).message)) throw new UpgradeInProgressError();
    throw error;
  }
}

/**
 * Records the agent's progress. Each step not recorded before gets its own audit row, so a status file
 * read twice (two CMS processes, a restart) audits each step once. Returns false when the request is
 * unknown or already final.
 */
export async function recordUpgradeProgress(input: { requestId: string; status: Exclude<UpgradeStatus, "requested">; steps: UpgradeStep[]; toDigest: string | null }): Promise<boolean> {
  if (!UUID.test(input.requestId)) return false;
  return withTransaction(async (trx) => {
    // The app may only read system_upgrades (no FOR UPDATE), so two CMS processes reading the same status
    // file serialise on a transaction lock instead; the second then sees the steps already recorded.
    await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('polynovea_system_upgrade_record'))`.execute(trx);
    const existing = await trx.selectFrom("system_upgrades").select(["steps_json", "status", "requested_by"]).where("request_id", "=", input.requestId).executeTakeFirst();
    if (!existing) return false;
    const before = parsed<UpgradeStep[]>(existing.steps_json, []);
    const { rows } = await sql<{ ok: boolean }>`select public.polynovea_system_upgrade_record(
      ${input.requestId}::uuid, ${input.status}, ${JSON.stringify(input.steps)}::jsonb, ${input.toDigest}) as ok`.execute(trx);
    if (!rows[0]?.ok) return false;
    const actor = (existing.requested_by as string | null) ?? null;
    for (const step of input.steps.slice(before.length)) {
      await audit(trx, actor, `system.upgrade.step.${step.step}`, input.requestId, { outcome: step.outcome, at: step.at, detail: step.detail ?? null });
    }
    if (FINAL_UPGRADE_STATUSES.includes(input.status)) {
      await audit(trx, actor, `system.upgrade.${input.status}`, input.requestId, { toDigest: input.toDigest });
    }
    return true;
  });
}

export async function listUpgrades(limit = 10): Promise<UpgradeRow[]> {
  const rows = await getDb().selectFrom("system_upgrades").selectAll().orderBy("requested_at", "desc").orderBy("id", "desc").limit(Math.min(Math.max(limit, 1), 50)).execute();
  return rows.map((row) => upgradeRow(row as unknown as Record<string, unknown>));
}

export async function openUpgrade(): Promise<UpgradeRow | null> {
  const row = await getDb().selectFrom("system_upgrades").selectAll().where("status", "in", ["requested", "running"]).executeTakeFirst();
  return row ? upgradeRow(row as unknown as Record<string, unknown>) : null;
}

export async function listRestoreTests(limit = 10): Promise<RestoreTestRow[]> {
  const rows = await getDb().selectFrom("system_restore_tests").selectAll().orderBy("started_at", "desc").orderBy("id", "desc").limit(Math.min(Math.max(limit, 1), 50)).execute();
  return rows.map((row) => restoreRow(row as unknown as Record<string, unknown>));
}

/** Begins a restore test; null while another one is running. */
export async function beginRestoreTest(reason: "monthly" | "first_backup" | "manual"): Promise<string | null> {
  const { rows } = await sql<{ id: string | null }>`select public.polynovea_system_restore_test_begin(${reason}) as id`.execute(getDb());
  return rows[0]?.id ?? null;
}

export async function finishRestoreTest(input: {
  id: string;
  status: "passed" | "failed" | "skipped";
  backupLabel: string | null;
  checks: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
}): Promise<boolean> {
  return withTransaction(async (trx) => {
    const { rows } = await sql<{ ok: boolean }>`select public.polynovea_system_restore_test_finish(
      ${input.id}::uuid, ${input.status}, ${input.backupLabel}, ${JSON.stringify(input.checks)}::jsonb, ${input.errorCode}, ${input.errorMessage}) as ok`.execute(trx);
    if (!rows[0]?.ok) return false;
    await audit(trx, null, `system.restore_test.${input.status}`, input.id, { backupLabel: input.backupLabel, errorCode: input.errorCode });
    return true;
  });
}

export async function workerHeartbeat(): Promise<string | null> {
  const row = await getDb().selectFrom("cms_runtime_state").select("worker_heartbeat_at").where("singleton", "=", true).executeTakeFirst();
  return iso(row?.worker_heartbeat_at);
}
