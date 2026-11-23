// Supabase path of the operational world model reads and writes (queries moved unchanged from
// worldModelService.ts; deleted with the switch at the end of phase 1). Node and edge derivation,
// the probes and the generated desired state stay in that service.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type DiscoveryInputs = { connections: any[]; websites: any[]; schemaRows: any[]; models: any[]; runtime: any | null; backups: any[]; doctor: any | null; syncStates: any[] };
export type PersistedEdge = { id: string; from_node_id: string; to_node_id: string; relationship: string };
export type WorldRecord = {
  workspaceId: string; environmentId: string; runId: string; startedAt: string;
  nodeRows: Array<Record<string, unknown>>;
  observationsFor: (nodeIdByKey: Map<string, string>) => Array<Record<string, unknown>>;
  edgesFor: (nodeIdByKey: Map<string, string>) => Array<Record<string, unknown>>;
  edgeObservationsFor: (edges: PersistedEdge[]) => Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
};

export async function startDiscovery(row: Record<string, unknown>): Promise<any> {
  const { data: run, error } = await createServiceRoleClient().from("operational_discovery_runs").insert(row).select().single();
  if (error || !run) throw new Error(error?.message || "Could not start operational discovery");
  return run;
}

export async function environmentRow(workspaceId: string, environmentId: string): Promise<any | null> {
  const { data: environment } = await createServiceRoleClient().from("workspace_environments").select("*").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  return environment ?? null;
}

/** Everything the world model is derived from, apart from the environment and the probes. */
export async function discoveryInputs(workspaceId: string, environmentId: string): Promise<DiscoveryInputs> {
  const db = createServiceRoleClient();
  const [connectionsResult, websitesResult, schemasResult, modelsResult, runtimeResult, backupsResult, doctorResult, syncResult] = await Promise.all([
    db.from("workspace_connections").select("id,name,connector_type,connector_family,status,active,config_json,metadata_json,last_verified_at,last_success_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("website_connection_bindings").select("id,connection_id,publication_target_id,integration_method,status,last_test_at,last_error").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("environment_schema_deployments").select("id,content_model_id,schema_version,schema_hash,status,deployed_at,metadata_json").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("deployed_at", { ascending: false }),
    db.from("content_models").select("id,api_key,name,status,current_schema_version").eq("workspace_id", workspaceId).eq("status", "active"),
    db.from("cms_runtime_state").select("schema_migration,app_version,worker_version,updated_at").eq("singleton", true).maybeSingle(),
    db.from("workspace_backups").select("id,status,checksum_sha256,created_at,verified_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("created_at", { ascending: false }).limit(5),
    db.from("system_doctor_runs").select("id,status,summary_json,checked_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("checked_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("analytics_sync_state").select("connector_id,status,fresh_through,last_success_at,last_error,updated_at").eq("workspace_id", workspaceId),
  ]);
  return {
    connections: connectionsResult.data ?? [], websites: websitesResult.data ?? [], schemaRows: schemasResult.data ?? [], models: modelsResult.data ?? [],
    runtime: runtimeResult.data ?? null, backups: backupsResult.data ?? [], doctor: doctorResult.data ?? null, syncStates: syncResult.data ?? [],
  };
}

export async function secretProvider(workspaceId: string, environmentId: string, providerId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient().from("workspace_secret_providers").select("id,name,provider_kind,status,config_json,updated_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).eq("id", providerId).maybeSingle();
  return data ?? null;
}

/**
 * Records a discovery: upserts the nodes and their observations, the edges and theirs, marks what
 * was not seen this run stale and completes the run.
 */
export async function recordDiscovery(record: WorldRecord): Promise<{ completed: any; nodes: Array<{ id: string; node_key: string }>; edges: PersistedEdge[] }> {
  const db = createServiceRoleClient();
  const { data: persistedNodes, error: nodesError } = await db.from("operational_world_nodes").upsert(record.nodeRows, { onConflict: "workspace_id,environment_id,node_key" }).select("id,node_key");
  if (nodesError) throw new Error(nodesError.message);
  const nodeIdByKey = new Map((persistedNodes ?? []).map((row) => [row.node_key, row.id]));
  const observationRows = record.observationsFor(nodeIdByKey);
  if (observationRows.length) {
    const { error } = await db.from("operational_observations").insert(observationRows);
    if (error) throw new Error(error.message);
  }
  const edgeRows = record.edgesFor(nodeIdByKey);
  const { data: persistedEdges, error: edgesError } = edgeRows.length
    ? await db.from("operational_world_edges").upsert(edgeRows, { onConflict: "environment_id,from_node_id,to_node_id,relationship" }).select("id,from_node_id,to_node_id,relationship")
    : { data: [], error: null };
  if (edgesError) throw new Error(edgesError.message);
  if (persistedEdges?.length) {
    const { error } = await db.from("operational_observations").insert(record.edgeObservationsFor(persistedEdges as PersistedEdge[]));
    if (error) throw new Error(error.message);
  }
  await db.from("operational_world_nodes").update({ is_stale: true }).eq("workspace_id", record.workspaceId).eq("environment_id", record.environmentId).lt("last_observed_at", record.startedAt);
  await db.from("operational_world_edges").update({ is_stale: true }).eq("workspace_id", record.workspaceId).eq("environment_id", record.environmentId).lt("last_observed_at", record.startedAt);
  const { data: completed, error: completeError } = await db.from("operational_discovery_runs").update({ status: "succeeded", completed_at: new Date().toISOString(), summary_json: record.summary }).eq("id", record.runId).select().single();
  if (completeError || !completed) throw new Error(completeError?.message || "Could not complete operational discovery");
  return { completed, nodes: persistedNodes ?? [], edges: (persistedEdges ?? []) as PersistedEdge[] };
}

export async function failDiscovery(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  void workspaceId; // the caller started the run in the workspace
  await createServiceRoleClient().from("operational_discovery_runs").update(patch).eq("id", runId);
}

export async function worldModel(workspaceId: string, environmentId: string): Promise<{ nodes: any[]; edges: any[]; latestDiscovery: any | null }> {
  const db = createServiceRoleClient();
  const [nodes, edges, latestDiscovery] = await Promise.all([
    db.from("operational_world_nodes").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("node_type").order("node_key"),
    db.from("operational_world_edges").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("relationship"),
    db.from("operational_discovery_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { nodes: nodes.data ?? [], edges: edges.data ?? [], latestDiscovery: latestDiscovery.data ?? null };
}

/** What the generated desired state is built from. */
export async function desiredStateInputs(workspaceId: string, environmentId: string): Promise<{ environment: any | null; components: any[]; connections: any[]; models: any[]; schemas: any[]; runtime: any | null; websites: any[] }> {
  const db = createServiceRoleClient();
  const [environmentResult, componentsResult, connectionsResult, modelsResult, schemasResult, runtimeResult, websitesResult] = await Promise.all([
    db.from("workspace_environments").select("id,status,kind").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle(),
    db.from("environment_components").select("component_key,capability_key,required,provider,state").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("workspace_connections").select("id,connector_type,connector_family,status,active").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("content_models").select("id,api_key,current_schema_version,status").eq("workspace_id", workspaceId).eq("status", "active"),
    db.from("environment_schema_deployments").select("content_model_id,schema_version,schema_hash,deployed_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("deployed_at", { ascending: false }),
    db.from("cms_runtime_state").select("schema_migration,app_version,worker_version").eq("singleton", true).maybeSingle(),
    db.from("website_connection_bindings").select("id,status").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
  ]);
  return {
    environment: environmentResult.data ?? null, components: componentsResult.data ?? [], connections: connectionsResult.data ?? [], models: modelsResult.data ?? [],
    schemas: schemasResult.data ?? [], runtime: runtimeResult.data ?? null, websites: websitesResult.data ?? [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
