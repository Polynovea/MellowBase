// Direct PostgreSQL implementation of the intelligence discovery, schema-deployment and overview
// reads and writes (phase 1, wave 4). Same signatures and shapes as discoveryData.supabase.ts.
// Differences that are deliberate:
// - A schema deployment, the environment's deployed-schema marker and the audit event commit
//   together (the Supabase path ignored a failed environment update and could audit a deployment
//   whose marker never moved). The upsert's update is scoped to the caller's workspace.
// - Lists keep their limits and gain a tie-breaking order; the capability reads, which feed one
//   environment's discovery, read every row in a fixed order.
// - Malformed ids answer "not found" without a query; database text never reaches the caller.
import { sql } from "kysely";
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { DatabaseConnectionRow } from "@/lib/intelligence/discoveryData.supabase";

export type { DatabaseConnectionRow } from "@/lib/intelligence/discoveryData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));

export async function changeAssessment(workspaceId: string, assessmentId: string): Promise<any | null> {
  if (!ids(assessmentId)) return null;
  return (await getDb().selectFrom("operational_change_assessments").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", assessmentId).executeTakeFirst()) ?? null;
}

export async function environmentKind(workspaceId: string, environmentId: string): Promise<{ id: string; kind: string } | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("workspace_environments").select(["id", "kind"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst()) ?? null;
}

export async function recordSchemaDeployment(
  row: Record<string, unknown> & { workspace_id: string; environment_id: string },
  environmentPatch: Record<string, unknown>,
  auditFor: (deployment: any) => PlatformAuditPayload,
): Promise<any> {
  const values = { ...row, metadata_json: JSON.stringify(row.metadata_json ?? {}) } as any;
  const update = Object.fromEntries(Object.keys(row).filter((key) => !["environment_id", "content_model_id", "schema_version"].includes(key)).map((key) => [key, sql.ref(`excluded.${key}`)]));
  try {
    return await withTransaction(async (trx) => {
      const deployment = await trx.insertInto("environment_schema_deployments").values(values)
        .onConflict((conflict) => conflict.columns(["environment_id", "content_model_id", "schema_version"]).doUpdateSet(update as any)
          .where("environment_schema_deployments.workspace_id", "=", row.workspace_id))
        .returningAll().executeTakeFirst();
      if (!deployment) throw new Error("Could not record canonical schema deployment");
      await trx.updateTable("workspace_environments").set(environmentPatch as any).where("workspace_id", "=", row.workspace_id).where("id", "=", row.environment_id).execute();
      await recordPlatformEvent(trx, auditFor(deployment));
      return deployment;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not record canonical schema deployment"));
  }
}

export async function databaseConnections(workspaceId: string, environmentId: string): Promise<DatabaseConnectionRow[]> {
  if (!ids(environmentId)) return [];
  return await getDb().selectFrom("workspace_connections").select(["id", "connector_type", "status", "active", "created_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("connector_family", "=", "database").where("active", "=", true)
    .orderBy("created_at", "desc").orderBy("id").execute() as DatabaseConnectionRow[];
}

export async function capabilityRows(workspaceId: string, environmentId: string): Promise<{ environment: any | null; connections: any[]; components: any[]; bindings: any[] }> {
  if (!ids(environmentId)) return { environment: null, connections: [], components: [], bindings: [] };
  const db = getDb();
  const [environment, connections, components, bindings] = await Promise.all([
    db.selectFrom("workspace_environments").select(["id", "kind", "status", "cms_base_url", "runtime_provider", "database_provider", "storage_provider"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst(),
    db.selectFrom("workspace_connections").select(["id", "name", "connector_type", "connector_family", "status", "active", "config_json", "metadata_json"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("environment_components").select(["id", "component_key", "state", "provider", "capability_key", "last_checked_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("component_key").orderBy("id").execute(),
    db.selectFrom("website_connection_bindings").select(["id", "connection_id", "integration_method", "status"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
  ]);
  return { environment: environment ?? null, connections, components, bindings };
}

export async function overviewRuns(workspaceId: string, environmentId: string): Promise<{ reconciliationRuns: any[]; discoveryRuns: any[]; remediationRuns: any[]; operationalEvents: any[] }> {
  if (!ids(environmentId)) return { reconciliationRuns: [], discoveryRuns: [], remediationRuns: [], operationalEvents: [] };
  const db = getDb();
  const [reconciliationRuns, discoveryRuns, remediationRuns, operationalEvents] = await Promise.all([
    db.selectFrom("operational_reconciliation_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("started_at", "desc").orderBy("id").limit(30).execute(),
    db.selectFrom("operational_discovery_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("started_at", "desc").orderBy("id").limit(30).execute(),
    db.selectFrom("operational_remediation_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("started_at", "desc").orderBy("id").limit(50).execute(),
    db.selectFrom("operational_events")
      .select(["id", "event_type", "source_type", "source_id", "occurred_at", "features_json", "outcome_json", "privacy_class", "eligible_for_local_learning", "eligible_for_cross_install_learning"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("occurred_at", "desc").orderBy("id").limit(100).execute(),
  ]);
  return { reconciliationRuns, discoveryRuns, remediationRuns, operationalEvents };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
