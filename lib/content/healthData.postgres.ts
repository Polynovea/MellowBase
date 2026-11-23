// Direct PostgreSQL implementation of the content-health reads and writes (phase 1, wave 3). Same
// signatures and shapes as healthData.supabase.ts. Differences that are deliberate:
// - Scans, the overview and resolution read every row (PostgREST capped each read at 1000, so a
//   large workspace's scan resolved findings it had just detected, and the overview undercounted).
// - Resolving undetected findings is one UPDATE in the workspace, so a finding that reopens during
//   the scan is not resolved from a stale list.
// - Remediation task writes commit with their audit events.
// - Messages raised by the database for the caller (the remediation task scope trigger, the SQL
//   functions) pass through; other database text never does.
import { sql } from "kysely";
import { callFunction, getDb, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const JSON_ARGS = new Set(["p_evidence"]);

async function call(name: "cms_upsert_health_finding" | "cms_upsert_content_health_profile", args: Record<string, unknown>, fallback: string): Promise<any> {
  try {
    const data = await callFunction(name, Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON_ARGS.has(key) && value != null ? JSON.stringify(value) : value])) as never);
    if (!data) throw new Error(fallback);
    return data;
  } catch (error) {
    if (error instanceof SqlFunctionError) throw error;
    throw new Error(clientErrorMessage(error, fallback));
  }
}

/** Rethrows a message the remediation task trigger raised for the caller; anything else is hidden. */
function raisedOrFallback(error: unknown, fallback: string): Error {
  const candidate = error as { code?: unknown; message?: unknown; where?: unknown };
  if ((candidate?.code === "P0002" || candidate?.code === "P0003") && typeof candidate.message === "string" && /\bRAISE\b/.test(String(candidate.where ?? ""))) {
    return new Error(candidate.message);
  }
  return new Error(clientErrorMessage(error, fallback));
}

export async function callUpsertHealthFinding(args: Record<string, unknown>): Promise<any> {
  return call("cms_upsert_health_finding", args, "Could not record health finding");
}

export async function scanRows(workspaceId: string): Promise<{ profiles: any[]; assets: Array<{ id: string; filename: string; mime_type: string | null; archived_at: string | null }> }> {
  const db = getDb();
  const [profiles, assets] = await Promise.all([
    db.selectFrom("content_health_profiles").selectAll().where("workspace_id", "=", workspaceId).orderBy("entry_id").execute(),
    db.selectFrom("assets").select(["id", "filename", "mime_type", "archived_at"]).where("workspace_id", "=", workspaceId).where("archived_at", "is", null).orderBy("id").execute(),
  ]);
  return { profiles, assets: assets as Array<{ id: string; filename: string; mime_type: string | null; archived_at: string | null }> };
}

export async function resolveUndetected(workspaceId: string, detected: Set<string>): Promise<number> {
  const now = new Date().toISOString();
  let query = getDb().updateTable("content_health_findings").set({ state: "resolved", resolved_at: now, updated_at: now })
    .where("workspace_id", "=", workspaceId).where("state", "in", ["open", "acknowledged"]);
  // One array parameter, so a workspace with many findings never runs into the bind-parameter limit.
  if (detected.size) query = query.where(sql<boolean>`fingerprint <> all(${[...detected]}::text[])`);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function overviewRows(workspaceId: string): Promise<{ findings: any[]; tasks: any[]; profiles: any[] }> {
  const db = getDb();
  const [findings, tasks, profiles] = await Promise.all([
    db.selectFrom("content_health_findings").selectAll().where("workspace_id", "=", workspaceId).orderBy("last_detected_at", "desc").orderBy("id").execute(),
    db.selectFrom("content_remediation_tasks").selectAll().where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute(),
    db.selectFrom("content_health_profiles").selectAll().where("workspace_id", "=", workspaceId).orderBy("entry_id").execute(),
  ]);
  return { findings, tasks, profiles };
}

export async function insertRemediationTask(row: Record<string, unknown>, auditFor: (task: any) => PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const task = await trx.insertInto("content_remediation_tasks").values(row as any).returningAll().executeTakeFirstOrThrow();
      await recordPlatformEvent(trx, auditFor(task));
      return task;
    });
  } catch (error) {
    throw raisedOrFallback(error, "Could not create remediation task");
  }
}

export async function updateRemediationTaskRow(workspaceId: string, id: string, patch: Record<string, unknown>, auditFor: (task: any) => PlatformAuditPayload): Promise<any | null> {
  try {
    return await withTransaction(async (trx) => {
      const task = await trx.updateTable("content_remediation_tasks").set(patch as any).where("workspace_id", "=", workspaceId).where("id", "=", id)
        .returningAll().executeTakeFirst();
      if (!task) return null;
      await recordPlatformEvent(trx, auditFor(task));
      return task;
    });
  } catch (error) {
    throw raisedOrFallback(error, "Could not update remediation task");
  }
}

export async function callUpsertHealthProfile(args: Record<string, unknown>): Promise<any> {
  return call("cms_upsert_content_health_profile", args, "Could not update content health profile");
}
/* eslint-enable @typescript-eslint/no-explicit-any */
