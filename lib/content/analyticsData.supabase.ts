// Supabase path of the content analytics reads and writes (queries moved unchanged from
// analyticsService.ts and analyticsIntelligenceService.ts; deleted with the switch at the end of
// phase 1). Input checks, the GA4 calls, path matching and the comparison stay in those services.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export type ConnectorRow = { id: string; workspace_id: string; provider: string; name: string; credential_mode: string; active: boolean; connection_id: string | null; config_json_encrypted: string | null; created_by: string | null; created_at: string; updated_at: string };
export type SyncRoute = { path: string; entry_id: string | null; locale: string };
const SNAPSHOT_KEY = "workspace_id,entry_id,version_id,source,period_start,period_end";

export async function upsertSnapshot(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("content_analytics_snapshots").upsert(row, { onConflict: SNAPSHOT_KEY }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

/** Whether the version belongs to the entry (the caller resolved the entry in the workspace). */
export async function versionBelongsToEntry(workspaceId: string, entryId: string, versionId: string): Promise<boolean> {
  void workspaceId;
  const { data } = await createServiceRoleClient().from("content_entry_versions").select("id").eq("id", versionId).eq("entry_id", entryId).maybeSingle();
  return Boolean(data);
}

export async function entrySnapshots(workspaceId: string, entryId: string): Promise<any[]> {
  const { data } = await createServiceRoleClient().from("content_analytics_snapshots").select("*").eq("workspace_id", workspaceId).eq("entry_id", entryId).order("period_end", { ascending: false }).limit(24);
  return data ?? [];
}

/** The workspace's GA4 connector, created with its sync state when there is none. */
export async function ensureGa4Connector(workspaceId: string, actorId: string): Promise<ConnectorRow> {
  const db = createServiceRoleClient();
  const { data: existing } = await db.from("analytics_connectors").select("*").eq("workspace_id", workspaceId).eq("provider", "ga4").eq("name", "GA4").maybeSingle();
  if (existing) return existing as ConnectorRow;
  const { data, error } = await db.from("analytics_connectors").insert({
    workspace_id: workspaceId,
    provider: "ga4",
    name: "GA4",
    credential_mode: "environment",
    active: true,
    created_by: actorId,
  }).select().single();
  if (error || !data) throw new Error(error?.message || "Could not create GA4 connector");
  await db.from("analytics_sync_state").insert({ connector_id: data.id, workspace_id: workspaceId, status: "never_synced" });
  return data as ConnectorRow;
}

export async function overviewRows(workspaceId: string): Promise<{ connectors: any[]; syncStates: any[]; snapshots: any[] }> {
  const db = createServiceRoleClient();
  const [{ data: connectors }, { data: states }, { data: snapshots }] = await Promise.all([
    db.from("analytics_connectors").select("id, provider, name, credential_mode, active, created_at, updated_at").eq("workspace_id", workspaceId).order("created_at"),
    db.from("analytics_sync_state").select("*").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }),
    db.from("content_analytics_snapshots").select("entry_id, version_id, destination_url, source, period_start, period_end, page_views, users_count, engagement_seconds, conversions, metrics_json, captured_at, data_fresh_through, connector_id").eq("workspace_id", workspaceId).order("period_end", { ascending: false }).limit(500),
  ]);
  return { connectors: connectors ?? [], syncStates: states ?? [], snapshots: snapshots ?? [] };
}

export async function connectorById(workspaceId: string, connectorId: string): Promise<ConnectorRow | null> {
  const { data } = await createServiceRoleClient().from("analytics_connectors").select("*").eq("workspace_id", workspaceId).eq("id", connectorId).maybeSingle();
  return (data as ConnectorRow | null) ?? null;
}

export async function upsertSyncState(row: Record<string, unknown>): Promise<void> {
  await createServiceRoleClient().from("analytics_sync_state").upsert(row, { onConflict: "connector_id" });
}

export async function connectionForSync(workspaceId: string, connectionId: string): Promise<{ id: string; config_json: any; status: string; active: boolean } | null> {
  const { data } = await createServiceRoleClient().from("workspace_connections").select("id,config_json,status,active").eq("workspace_id", workspaceId).eq("id", connectionId).maybeSingle();
  return data ?? null;
}

/** Canonical active routes with an entry, and those entries' published versions. */
export async function syncTargets(workspaceId: string): Promise<{ routes: SyncRoute[]; entries: Array<{ id: string; published_version_id: string | null }> }> {
  const db = createServiceRoleClient();
  const { data: routes } = await db.from("content_routes").select("path, entry_id, locale").eq("workspace_id", workspaceId).eq("is_canonical", true).eq("status", "active").not("entry_id", "is", null);
  const entryIds = [...new Set((routes ?? []).map((route) => route.entry_id).filter((id): id is string => Boolean(id)))];
  const { data: entries } = entryIds.length ? await db.from("content_entries").select("id, published_version_id").eq("workspace_id", workspaceId).in("id", entryIds) : { data: [] as Array<{ id: string; published_version_id: string | null }> };
  return { routes: (routes ?? []) as SyncRoute[], entries: entries ?? [] };
}

/** Writes a sync's snapshots; returns how many were written. */
export async function writeSyncSnapshots(rows: Array<Record<string, unknown>>): Promise<number> {
  const db = createServiceRoleClient();
  let written = 0;
  for (const row of rows) {
    const { error } = await db.from("content_analytics_snapshots").upsert(row, { onConflict: SNAPSHOT_KEY });
    if (error) throw new Error(error.message);
    written += 1;
  }
  return written;
}

export async function performanceRows(workspaceId: string, entryId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("content_analytics_snapshots")
    .select("period_start, period_end, page_views, users_count, engagement_seconds, conversions, metrics_json, data_fresh_through, captured_at, version_id")
    .eq("workspace_id", workspaceId).eq("entry_id", entryId).eq("source", "ga4").order("period_end", { ascending: false }).limit(12);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
