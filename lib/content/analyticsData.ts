// PostgreSQL implementation of the content analytics reads and writes (phase 1, wave 3). Deliberate
// differences from the Supabase path it replaced in phase 1:
// - A version is checked against its entry through the entry's workspace.
// - A new GA4 connector and its sync state commit together, and a concurrent create returns the
// connector that won instead of failing on the unique key.
// - A sync's snapshots are written in one transaction, so a failed sync leaves the previous
// snapshots in place instead of a half-written window.
// - The sync reads every route (PostgREST capped it at 1000, so a large site's tail was never
// synced); lists keep their limits and gain a tie-breaking order.
// - jsonb values are serialized explicitly; database text never reaches the caller.
import { sql } from "kysely";
import { getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
export type ConnectorRow = { id: string; workspace_id: string; provider: string; name: string; credential_mode: string; active: boolean; connection_id: string | null; config_json_encrypted: string | null; created_by: string | null; created_at: string; updated_at: string };
export type SyncRoute = { path: string; entry_id: string | null; locale: string };


/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the services read them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_COLUMNS = ["version_id", "destination_url", "page_views", "users_count", "engagement_seconds", "conversions", "metrics_json", "connector_id", "sync_correlation_id", "data_fresh_through", "captured_at"] as const;

function snapshotValues(row: Record<string, unknown>) {
  return { ...row, metrics_json: JSON.stringify(row.metrics_json ?? {}) } as any;
}

/** Upsert on the snapshot key (null version included); only the columns the row sets are replaced. */
function upsertQuery(executor: ReturnType<typeof getDb>, row: Record<string, unknown>) {
  const update = Object.fromEntries(SNAPSHOT_COLUMNS.filter((column) => column in row).map((column) => [column, sql.ref(`excluded.${column}`)]));
  return executor.insertInto("content_analytics_snapshots").values(snapshotValues(row))
    .onConflict((conflict) => conflict.columns(["workspace_id", "entry_id", "version_id", "source", "period_start", "period_end"]).doUpdateSet(update as any));
}

export async function upsertSnapshot(row: Record<string, unknown>): Promise<any> {
  try {
    return await upsertQuery(getDb(), row).returningAll().executeTakeFirstOrThrow();
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not record analytics"));
  }
}

export async function versionBelongsToEntry(workspaceId: string, entryId: string, versionId: string): Promise<boolean> {
  if (!UUID.test(entryId) || !UUID.test(versionId)) return false;
  const row = maybeOne(await getDb().selectFrom("content_entry_versions as v").innerJoin("content_entries as e", "e.id", "v.entry_id")
    .select("v.id").where("e.workspace_id", "=", workspaceId).where("v.entry_id", "=", entryId).where("v.id", "=", versionId).execute());
  return Boolean(row);
}

export async function entrySnapshots(workspaceId: string, entryId: string): Promise<any[]> {
  if (!UUID.test(entryId)) return [];
  return getDb().selectFrom("content_analytics_snapshots").selectAll().where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId)
    .orderBy("period_end", "desc").orderBy("captured_at", "desc").orderBy("id").limit(24).execute();
}

export async function ensureGa4Connector(workspaceId: string, actorId: string): Promise<ConnectorRow> {
  const find = () => getDb().selectFrom("analytics_connectors").selectAll().where("workspace_id", "=", workspaceId).where("provider", "=", "ga4").where("name", "=", "GA4").executeTakeFirst();
  const existing = await find();
  if (existing) return existing as ConnectorRow;
  const created = await withTransaction(async (trx) => {
    const connector = await trx.insertInto("analytics_connectors")
      .values({ workspace_id: workspaceId, provider: "ga4", name: "GA4", credential_mode: "environment", active: true, created_by: actorId })
      .onConflict((conflict) => conflict.columns(["workspace_id", "provider", "name"]).doNothing())
      .returningAll().executeTakeFirst();
    if (connector) await trx.insertInto("analytics_sync_state").values({ connector_id: connector.id, workspace_id: workspaceId, status: "never_synced" }).execute();
    return connector;
  });
  const connector = created ?? await find();
  if (!connector) throw new Error("Could not create GA4 connector");
  return connector as ConnectorRow;
}

export async function overviewRows(workspaceId: string): Promise<{ connectors: any[]; syncStates: any[]; snapshots: any[] }> {
  const db = getDb();
  const [connectors, syncStates, snapshots] = await Promise.all([
    db.selectFrom("analytics_connectors").select(["id", "provider", "name", "credential_mode", "active", "created_at", "updated_at"]).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("analytics_sync_state").selectAll().where("workspace_id", "=", workspaceId).orderBy("updated_at", "desc").orderBy("connector_id").execute(),
    db.selectFrom("content_analytics_snapshots")
      .select(["entry_id", "version_id", "destination_url", "source", "period_start", "period_end", "page_views", "users_count", "engagement_seconds", "conversions", "metrics_json", "captured_at", "data_fresh_through", "connector_id"])
      .where("workspace_id", "=", workspaceId).orderBy("period_end", "desc").orderBy("id").limit(500).execute(),
  ]);
  return { connectors, syncStates, snapshots };
}

export async function connectorById(workspaceId: string, connectorId: string): Promise<ConnectorRow | null> {
  if (!UUID.test(connectorId)) return null;
  return ((await getDb().selectFrom("analytics_connectors").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", connectorId).executeTakeFirst()) as ConnectorRow | undefined) ?? null;
}

export async function upsertSyncState(row: Record<string, unknown>): Promise<void> {
  const update = Object.fromEntries(Object.keys(row).filter((key) => key !== "connector_id").map((key) => [key, sql.ref(`excluded.${key}`)]));
  await getDb().insertInto("analytics_sync_state").values(row as any)
    .onConflict((conflict) => conflict.column("connector_id").doUpdateSet(update as any)).execute();
}

export async function connectionForSync(workspaceId: string, connectionId: string): Promise<{ id: string; config_json: any; status: string; active: boolean } | null> {
  if (!UUID.test(connectionId)) return null;
  return (await getDb().selectFrom("workspace_connections").select(["id", "config_json", "status", "active"])
    .where("workspace_id", "=", workspaceId).where("id", "=", connectionId).executeTakeFirst()) ?? null;
}

export async function syncTargets(workspaceId: string): Promise<{ routes: SyncRoute[]; entries: Array<{ id: string; published_version_id: string | null }> }> {
  const db = getDb();
  const routes = await db.selectFrom("content_routes").select(["path", "entry_id", "locale"])
    .where("workspace_id", "=", workspaceId).where("is_canonical", "=", true).where("status", "=", "active").where("entry_id", "is not", null)
    .orderBy("path").orderBy("id").execute();
  const entryIds = [...new Set(routes.map((route) => route.entry_id).filter((id): id is string => Boolean(id)))];
  const entries = entryIds.length
    ? await db.selectFrom("content_entries").select(["id", "published_version_id"]).where("workspace_id", "=", workspaceId).where("id", "=", sql<string>`any(${entryIds}::uuid[])`).execute()
    : [];
  return { routes, entries };
}

export async function writeSyncSnapshots(rows: Array<Record<string, unknown>>): Promise<number> {
  if (!rows.length) return 0;
  try {
    return await withTransaction(async (trx) => {
      for (const row of rows) await upsertQuery(trx as unknown as ReturnType<typeof getDb>, row).execute();
      return rows.length;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not write analytics snapshots"));
  }
}

export async function performanceRows(workspaceId: string, entryId: string): Promise<any[]> {
  if (!UUID.test(entryId)) return [];
  return getDb().selectFrom("content_analytics_snapshots")
    .select(["period_start", "period_end", "page_views", "users_count", "engagement_seconds", "conversions", "metrics_json", "data_fresh_through", "captured_at", "version_id"])
    .where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId).where("source", "=", "ga4")
    .orderBy("period_end", "desc").orderBy("captured_at", "desc").orderBy("id").limit(12).execute();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
