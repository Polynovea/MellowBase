// Direct PostgreSQL implementation of the operational world model reads and writes (phase 1,
// wave 4). Same signatures and shapes as worldData.supabase.ts. Differences that are deliberate:
// - A discovery's nodes, edges, observations, stale marking and the run's completion commit
//   together, so a failed discovery leaves the previous world model intact instead of half
//   replaced (the Supabase path could leave new nodes with no edges, or everything marked stale).
// - Node and edge upserts only update rows of the caller's workspace; run updates are scoped by
//   workspace_id as well as id.
// - Reads have a fixed order (id tie-breaks); jsonb values are serialized explicitly; database
//   text never reaches the caller.
import { sql } from "kysely";
import { getDb, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import type { DiscoveryInputs, PersistedEdge, WorldRecord } from "@/lib/intelligence/worldData.supabase";

export type { DiscoveryInputs, PersistedEdge, WorldRecord } from "@/lib/intelligence/worldData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (...values: string[]) => values.every((value) => UUID.test(value));
const JSON_COLUMNS = ["error_json", "summary_json", "attributes_json", "evidence_json", "value_json"];
const json = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, JSON_COLUMNS.includes(key) && value !== undefined ? JSON.stringify(value) : value])) as any;
const excluded = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.keys(row).filter((key) => !keys.includes(key)).map((key) => [key, sql.ref(`excluded.${key}`)])) as any;

export async function startDiscovery(row: Record<string, unknown>): Promise<any> {
  try {
    return await getDb().insertInto("operational_discovery_runs").values(json(row)).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not start operational discovery"));
  }
}

export async function environmentRow(workspaceId: string, environmentId: string): Promise<any | null> {
  if (!ids(environmentId)) return null;
  return (await getDb().selectFrom("workspace_environments").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst()) ?? null;
}

export async function discoveryInputs(workspaceId: string, environmentId: string): Promise<DiscoveryInputs> {
  if (!ids(environmentId)) return { connections: [], websites: [], schemaRows: [], models: [], runtime: null, backups: [], doctor: null, syncStates: [] };
  const db = getDb();
  const [connections, websites, schemaRows, models, runtime, backups, doctor, syncStates] = await Promise.all([
    db.selectFrom("workspace_connections").select(["id", "name", "connector_type", "connector_family", "status", "active", "config_json", "metadata_json", "last_verified_at", "last_success_at"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("website_connection_bindings").select(["id", "connection_id", "publication_target_id", "integration_method", "status", "last_test_at", "last_error"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
    db.selectFrom("environment_schema_deployments").select(["id", "content_model_id", "schema_version", "schema_hash", "status", "deployed_at", "metadata_json"])
      .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("deployed_at", "desc").orderBy("id").execute(),
    db.selectFrom("content_models").select(["id", "api_key", "name", "status", "current_schema_version"]).where("workspace_id", "=", workspaceId).where("status", "=", "active").orderBy("id").execute(),
    db.selectFrom("cms_runtime_state").select(["schema_migration", "app_version", "worker_version", "updated_at"]).where("singleton", "=", true).executeTakeFirst(),
    db.selectFrom("workspace_backups").select(["id", "status", "checksum_sha256", "created_at", "verified_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
      .orderBy("created_at", "desc").orderBy("id").limit(5).execute(),
    db.selectFrom("system_doctor_runs").select(["id", "status", "summary_json", "checked_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
      .orderBy("checked_at", "desc").orderBy("id").limit(1).executeTakeFirst(),
    db.selectFrom("analytics_sync_state").select(["connector_id", "status", "fresh_through", "last_success_at", "last_error", "updated_at"]).where("workspace_id", "=", workspaceId).orderBy("connector_id").execute(),
  ]);
  return { connections, websites, schemaRows, models, runtime: runtime ?? null, backups, doctor: doctor ?? null, syncStates };
}

export async function secretProvider(workspaceId: string, environmentId: string, providerId: string): Promise<any | null> {
  if (!ids(environmentId, providerId)) return null;
  return (await getDb().selectFrom("workspace_secret_providers").select(["id", "name", "provider_kind", "status", "config_json", "updated_at"])
    .where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).where("id", "=", providerId).executeTakeFirst()) ?? null;
}

export async function recordDiscovery(record: WorldRecord): Promise<{ completed: any; nodes: Array<{ id: string; node_key: string }>; edges: PersistedEdge[] }> {
  try {
    return await withTransaction(async (trx) => {
      const nodes = record.nodeRows.length
        ? await trx.insertInto("operational_world_nodes").values(record.nodeRows.map(json))
          .onConflict((conflict) => conflict.columns(["workspace_id", "environment_id", "node_key"]).doUpdateSet(excluded(record.nodeRows[0], ["workspace_id", "environment_id", "node_key"]))
            .where("operational_world_nodes.workspace_id", "=", record.workspaceId))
          .returning(["id", "node_key"]).execute()
        : [];
      const nodeIdByKey = new Map(nodes.map((row) => [row.node_key, row.id]));
      const observationRows = record.observationsFor(nodeIdByKey);
      if (observationRows.length) await trx.insertInto("operational_observations").values(observationRows.map(json)).execute();
      const edgeRows = record.edgesFor(nodeIdByKey);
      const edges = edgeRows.length
        ? await trx.insertInto("operational_world_edges").values(edgeRows.map(json))
          .onConflict((conflict) => conflict.columns(["environment_id", "from_node_id", "to_node_id", "relationship"]).doUpdateSet(excluded(edgeRows[0], ["environment_id", "from_node_id", "to_node_id", "relationship"]))
            .where("operational_world_edges.workspace_id", "=", record.workspaceId))
          .returning(["id", "from_node_id", "to_node_id", "relationship"]).execute() as PersistedEdge[]
        : [];
      if (edges.length) await trx.insertInto("operational_observations").values(record.edgeObservationsFor(edges).map(json)).execute();
      await trx.updateTable("operational_world_nodes").set({ is_stale: true }).where("workspace_id", "=", record.workspaceId).where("environment_id", "=", record.environmentId).where("last_observed_at", "<", record.startedAt).execute();
      await trx.updateTable("operational_world_edges").set({ is_stale: true }).where("workspace_id", "=", record.workspaceId).where("environment_id", "=", record.environmentId).where("last_observed_at", "<", record.startedAt).execute();
      const completed = await trx.updateTable("operational_discovery_runs").set(json({ status: "succeeded", completed_at: new Date().toISOString(), summary_json: record.summary }))
        .where("workspace_id", "=", record.workspaceId).where("id", "=", record.runId).returningAll().executeTakeFirst();
      if (!completed) throw new Error("Could not complete operational discovery");
      return { completed, nodes, edges };
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not complete operational discovery"));
  }
}

export async function failDiscovery(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  await getDb().updateTable("operational_discovery_runs").set(json(patch)).where("workspace_id", "=", workspaceId).where("id", "=", runId).execute();
}

export async function worldModel(workspaceId: string, environmentId: string): Promise<{ nodes: any[]; edges: any[]; latestDiscovery: any | null }> {
  if (!ids(environmentId)) return { nodes: [], edges: [], latestDiscovery: null };
  const db = getDb();
  const [nodes, edges, latestDiscovery] = await Promise.all([
    db.selectFrom("operational_world_nodes").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("node_type").orderBy("node_key").execute(),
    db.selectFrom("operational_world_edges").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("relationship").orderBy("id").execute(),
    db.selectFrom("operational_discovery_runs").selectAll().where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("started_at", "desc").orderBy("id").limit(1).executeTakeFirst(),
  ]);
  return { nodes, edges, latestDiscovery: latestDiscovery ?? null };
}

export async function desiredStateInputs(workspaceId: string, environmentId: string): Promise<{ environment: any | null; components: any[]; connections: any[]; models: any[]; schemas: any[]; runtime: any | null; websites: any[] }> {
  if (!ids(environmentId)) return { environment: null, components: [], connections: [], models: [], schemas: [], runtime: null, websites: [] };
  const db = getDb();
  const [environment, components, connections, models, schemas, runtime, websites] = await Promise.all([
    db.selectFrom("workspace_environments").select(["id", "status", "kind"]).where("workspace_id", "=", workspaceId).where("id", "=", environmentId).executeTakeFirst(),
    db.selectFrom("environment_components").select(["component_key", "capability_key", "required", "provider", "state"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("component_key").execute(),
    db.selectFrom("workspace_connections").select(["id", "connector_type", "connector_family", "status", "active"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
    db.selectFrom("content_models").select(["id", "api_key", "current_schema_version", "status"]).where("workspace_id", "=", workspaceId).where("status", "=", "active").orderBy("id").execute(),
    db.selectFrom("environment_schema_deployments").select(["content_model_id", "schema_version", "schema_hash", "deployed_at"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId)
      .orderBy("deployed_at", "desc").orderBy("id").execute(),
    db.selectFrom("cms_runtime_state").select(["schema_migration", "app_version", "worker_version"]).where("singleton", "=", true).executeTakeFirst(),
    db.selectFrom("website_connection_bindings").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("environment_id", "=", environmentId).orderBy("id").execute(),
  ]);
  return { environment: environment ?? null, components, connections, models, schemas, runtime: runtime ?? null, websites };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
