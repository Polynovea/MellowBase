// Supabase path of the intelligence discovery, schema-deployment and overview reads and writes
// (queries moved unchanged from deepDiscoveryService.ts, providerCapabilityDiscoveryService.ts,
// schemaDeploymentService.ts and operationalIntelligenceService.ts; deleted with the switch at the
// end of phase 1). The probes, the deployment gates and the overview assembly stay in those services.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export type DatabaseConnectionRow = { id: string; connector_type: string; name: string; status: string; active: boolean; created_at: string };

export async function changeAssessment(workspaceId: string, assessmentId: string): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("operational_change_assessments").select("*").eq("workspace_id", workspaceId).eq("id", assessmentId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

export async function environmentKind(workspaceId: string, environmentId: string): Promise<{ id: string; kind: string } | null> {
  const { data: environment } = await createServiceRoleClient().from("workspace_environments").select("id,kind").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle();
  return environment ?? null;
}

/**
 * Records a canonical schema deployment for an environment of the workspace (upsert on environment,
 * model and version), marks the environment's deployed schema and writes the audit event.
 */
export async function recordSchemaDeployment(
  row: Record<string, unknown> & { workspace_id: string; environment_id: string },
  environmentPatch: Record<string, unknown>,
  auditFor: (deployment: any) => PlatformAuditPayload,
): Promise<any> {
  const db = createServiceRoleClient();
  const { data: deployment, error } = await db.from("environment_schema_deployments").upsert(row, { onConflict: "environment_id,content_model_id,schema_version" }).select().single();
  if (error || !deployment) throw new Error(error?.message || "Could not record canonical schema deployment");
  await db.from("workspace_environments").update(environmentPatch).eq("workspace_id", row.workspace_id).eq("id", row.environment_id);
  await logPlatformEvent(auditFor(deployment));
  return deployment;
}

/** The environment's active database connections, newest first. */
export async function databaseConnections(workspaceId: string, environmentId: string): Promise<DatabaseConnectionRow[]> {
  const { data, error } = await createServiceRoleClient().from("workspace_connections")
    .select("id,connector_type,name,status,active,created_at")
    .eq("workspace_id", workspaceId)
    .eq("environment_id", environmentId)
    .eq("connector_family", "database")
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as DatabaseConnectionRow[];
}

/** The environment, its connections, components and website bindings, for capability discovery. */
export async function capabilityRows(workspaceId: string, environmentId: string): Promise<{ environment: any | null; connections: any[]; components: any[]; bindings: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: environment }, { data: connections }, { data: components }, { data: bindings }] = await Promise.all([
    db.from("workspace_environments").select("id,kind,status,cms_base_url,runtime_provider,database_provider,storage_provider").eq("workspace_id", workspaceId).eq("id", environmentId).maybeSingle(),
    db.from("workspace_connections").select("id,name,connector_type,connector_family,status,active,config_json,metadata_json").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("environment_components").select("id,component_key,state,provider,capability_key,last_checked_at").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
    db.from("website_connection_bindings").select("id,connection_id,integration_method,status").eq("workspace_id", workspaceId).eq("environment_id", environmentId),
  ]);
  return { environment: environment ?? null, connections: connections ?? [], components: components ?? [], bindings: bindings ?? [] };
}

/** Recent reconciliation, discovery and remediation runs and operational events, for the overview. */
export async function overviewRuns(workspaceId: string, environmentId: string): Promise<{ reconciliationRuns: any[]; discoveryRuns: any[]; remediationRuns: any[]; operationalEvents: any[] }> {
  const db = createServiceRoleClient();
  const [reconciliation, discovery, remediation, events] = await Promise.all([
    db.from("operational_reconciliation_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("started_at", { ascending: false }).limit(30),
    db.from("operational_discovery_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("started_at", { ascending: false }).limit(30),
    db.from("operational_remediation_runs").select("*").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("started_at", { ascending: false }).limit(50),
    db.from("operational_events").select("id,event_type,source_type,source_id,occurred_at,features_json,outcome_json,privacy_class,eligible_for_local_learning,eligible_for_cross_install_learning").eq("workspace_id", workspaceId).eq("environment_id", environmentId).order("occurred_at", { ascending: false }).limit(100),
  ]);
  return { reconciliationRuns: reconciliation.data ?? [], discoveryRuns: discovery.data ?? [], remediationRuns: remediation.data ?? [], operationalEvents: events.data ?? [] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
