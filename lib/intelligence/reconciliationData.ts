// PostgreSQL implementation of the desired-state and reconciliation reads and writes (phase 1, wave
// 4). Deliberate differences from the Supabase path it replaced in phase 1:
// - A new revision takes its number under a lock on the environment row, so two concurrent
// creates cannot both pick latest + 1 (the Supabase path failed one of them on the unique key).
// - A reconciliation's drift upsert, the resolution of drift that went away, the run's completion
// and the audit event commit together; resolution is one UPDATE scoped to the workspace.
// - Run updates are scoped by workspace_id as well as id.
// - The drift list keeps PostgREST's effective 1000-row bound as an explicit limit, with an id
// tie-break; jsonb values are serialized explicitly; database text never reaches the caller.
import { sql } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, getDb, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type ReconciliationCompletion = { status: string; summary_json: Record<string, unknown>; completed_at: string };


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));
const json = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, keys.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;

const revisions = (workspaceId: string, environmentId: string) =>
  getDb().selectFrom("operational_desired_state_revisions").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId);

export async function listRevisions(workspaceId: string, environmentId: string): Promise<any[]> {
  if (!ids(environmentId)) return [];
  return revisions(workspaceId, environmentId).orderBy("revision", "desc").execute();
}

export async function activeRevision(workspaceId: string, environmentId: string): Promise<any | null> {
  if (!ids(environmentId)) return null;
  return (await revisions(workspaceId, environmentId).where("status", "=", "active").executeTakeFirst()) ?? null;
}

export async function revisionById(workspaceId: string, environmentId: string, revisionId: string): Promise<any | null> {
  if (!ids(environmentId, revisionId)) return null;
  return (await revisions(workspaceId, environmentId).where("id", "=", revisionId).executeTakeFirst()) ?? null;
}

export async function revisionByChecksum(workspaceId: string, environmentId: string, checksum: string): Promise<any | null> {
  if (!ids(environmentId)) return null;
  return (await revisions(workspaceId, environmentId).where("checksum_sha256", "=", checksum).executeTakeFirst()) ?? null;
}

export async function createRevision(row: Record<string, unknown> & { workspace_id: string; environment_id: string }, auditFor: (revision: any) => PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const environment = await trx.selectFrom("workspace_environments").select("id").where("workspace_id", "=", row.workspace_id).where("id", "=", row.environment_id).forUpdate().executeTakeFirst();
      if (!environment) throw new Error("Environment not found");
      const latest = await trx.selectFrom("operational_desired_state_revisions").select(sql<number>`coalesce(max(revision), 0)`.as("revision"))
        .where("environment_id", "=", row.environment_id).executeTakeFirstOrThrow();
      const created = await trx.insertInto("operational_desired_state_revisions").values(json({ ...row, revision: Number(latest.revision) + 1 }, ["desired_json"]))
        .returningAll().executeTakeFirstOrThrow();
      await recordPlatformEvent(trx, auditFor(created));
      return created;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not create desired-state revision"));
  }
}

export async function callActivateRevision(args: Record<string, unknown>): Promise<any> {
  try {
    const data = await callFunction("cms_activate_operational_desired_state", args as never);
    if (!data) throw Object.assign(new Error("Could not activate desired-state revision"), { status: 400 });
    return data;
  } catch (error) {
    if (error instanceof SqlFunctionError) throw Object.assign(new Error(error.message), { status: error.sqlState === "P0002" ? 404 : 400 });
    if ((error as { status?: number })?.status) throw error;
    throw Object.assign(new Error(clientErrorMessage(error, "Could not activate desired-state revision")), { status: 400 });
  }
}

export async function environmentState(workspaceId: string, environmentId: string): Promise<{ id: string; kind: string; status: string } | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("workspace_environments").select(["id", "kind", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst()) ?? null;
}

export async function startReconciliation(row: Record<string, unknown>): Promise<any> {
  try {
    return await getDb().insertInto("operational_reconciliation_runs").values(json(row, ["summary_json"])).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not start reconciliation"));
  }
}

export async function applyReconciliation(params: {
  workspaceId: string; environmentId: string; revisionId: string; runId: string; rows: Array<Record<string, unknown>>; currentKeys: Set<string>; now: string;
  completion: (resolved: number) => ReconciliationCompletion; auditFor: (completed: any, resolved: number) => PlatformAuditPayload;
}): Promise<{ completed: any; resolved: number }> {
  try {
    return await withTransaction(async (trx) => {
      if (params.rows.length) {
        await trx.insertInto("operational_drift_items").values(params.rows.map((row) => json(row, ["current_json", "desired_json", "evidence_json"])))
          .onConflict((conflict) => conflict.columns(["environment_id", "desired_state_revision_id", "drift_key"]).doUpdateSet({
            reconciliation_run_id: sql.ref("excluded.reconciliation_run_id"), node_id: sql.ref("excluded.node_id"), category: sql.ref("excluded.category"),
            severity: sql.ref("excluded.severity"), action_class: sql.ref("excluded.action_class"), state: sql.ref("excluded.state"),
            current_json: sql.ref("excluded.current_json"), desired_json: sql.ref("excluded.desired_json"), evidence_json: sql.ref("excluded.evidence_json"),
            last_seen_at: sql.ref("excluded.last_seen_at"), resolved_at: sql.ref("excluded.resolved_at"),
          } as any).where("operational_drift_items.workspace_id", "=", params.workspaceId))
          .execute();
      }
      let resolve = trx.updateTable("operational_drift_items").set({ state: "resolved", resolved_at: params.now, last_seen_at: params.now })
        .where("workspace_id", "=", params.workspaceId).where("environment_id", "=", params.environmentId).where("desired_state_revision_id", "=", params.revisionId)
        .where("state", "in", ["open", "acknowledged", "planned"]);
      if (params.currentKeys.size) resolve = resolve.where(sql<boolean>`drift_key <> all(${[...params.currentKeys]}::text[])`);
      const resolved = Number((await resolve.executeTakeFirst()).numUpdatedRows);
      const completed = await trx.updateTable("operational_reconciliation_runs").set(json(params.completion(resolved), ["summary_json"]))
        .where("workspace_id", "=", params.workspaceId).where("id", "=", params.runId).returningAll().executeTakeFirst();
      if (!completed) throw new Error("Could not complete reconciliation");
      await recordPlatformEvent(trx, params.auditFor(completed, resolved));
      return { completed, resolved };
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not complete reconciliation"));
  }
}

export async function failReconciliation(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  await getDb().updateTable("operational_reconciliation_runs").set(json(patch, ["summary_json"])).where("workspace_id", "=", workspaceId).where("id", "=", runId).execute();
}

export async function listDrift(workspaceId: string, environmentId: string): Promise<any[]> {
  if (!ids(environmentId)) return [];
  return getDb().selectFrom("operational_drift_items").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
    .orderBy("last_seen_at", "desc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
