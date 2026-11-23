// PostgreSQL implementation of the deterministic remediation reads and writes (phase 1, wave 4).
// Deliberate differences from the Supabase path it replaced in phase 1:
// - Run updates are scoped by workspace_id as well as id.
// - Completing a run, its outcome event and the audit event commit together; failing a run and its
// outcome event commit together (the Supabase path could leave a run "running" with an event, or
// the reverse).
// - The auto-repair reads see every open drift item and node in a fixed order (PostgREST stopped at
// 1000, so a large environment's later drift was never repaired).
// - jsonb values are serialized explicitly; database text never reaches the caller.
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_JSON = ["safe_input_json", "safe_result_json", "verification_json"];
const EVENT_JSON = ["features_json", "outcome_json"];
const json = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, keys.includes(key) && value !== undefined ? JSON.stringify(value ?? {}) : value])) as any;

export async function enabledRegistry(): Promise<any[]> {
  return getDb().selectFrom("operational_remediation_registry").selectAll().where("enabled", "=", true).orderBy("remediation_key").execute();
}

export async function registryEntry(remediationKey: string): Promise<any | null> {
  return (await getDb().selectFrom("operational_remediation_registry").selectAll().where("remediation_key", "=", remediationKey).where("enabled", "=", true).executeTakeFirst()) ?? null;
}

export async function driftInEnvironment(workspaceId: string, environmentId: string, driftItemId: string): Promise<boolean> {
  if (!UUID.test(environmentId) || !UUID.test(driftItemId)) return false;
  return Boolean(await getDb().selectFrom("operational_drift_items").select("id")
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", driftItemId).executeTakeFirst());
}

export async function startRun(row: Record<string, unknown>): Promise<any> {
  try {
    return await getDb().insertInto("operational_remediation_runs").values(json(row, RUN_JSON)).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not start remediation run"));
  }
}

export async function completeRun(workspaceId: string, runId: string, patch: Record<string, unknown>, outcomeEvent: Record<string, unknown>, auditFor: (run: any) => PlatformAuditPayload): Promise<any> {
  try {
    return await withTransaction(async (trx) => {
      const completed = await trx.updateTable("operational_remediation_runs").set(json(patch, RUN_JSON)).where("workspace_id", "=", workspaceId).where("id", "=", runId)
        .returningAll().executeTakeFirst();
      if (!completed) throw new Error("Could not finalize remediation run");
      await trx.insertInto("operational_events").values(json({ ...outcomeEvent, source_id: completed.id }, EVENT_JSON)).execute();
      await recordPlatformEvent(trx, auditFor(completed));
      return completed;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not finalize remediation run"));
  }
}

export async function failRun(workspaceId: string, runId: string, patch: Record<string, unknown>, outcomeEvent: Record<string, unknown>): Promise<void> {
  await withTransaction(async (trx) => {
    await trx.updateTable("operational_remediation_runs").set(json(patch, RUN_JSON)).where("workspace_id", "=", workspaceId).where("id", "=", runId).execute();
    await trx.insertInto("operational_events").values(json({ ...outcomeEvent, source_id: runId }, EVENT_JSON)).execute();
  });
}

export async function autoRepairRows(workspaceId: string, environmentId: string, desiredStateRevisionId: string): Promise<{ drifts: any[]; nodes: Array<{ id: string; source_entity_id: string | null }> }> {
  if (!UUID.test(environmentId) || !UUID.test(desiredStateRevisionId)) return { drifts: [], nodes: [] };
  const db = getDb();
  const [drifts, nodes] = await Promise.all([
    db.selectFrom("operational_drift_items").selectAll()
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("desired_state_revision_id", "=", desiredStateRevisionId)
      .where("state", "=", "open").where("action_class", "=", "safe_auto_repair").orderBy("severity").orderBy("id").execute(),
    db.selectFrom("operational_world_nodes").select(["id", "source_entity_id"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
  ]);
  return { drifts, nodes };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
