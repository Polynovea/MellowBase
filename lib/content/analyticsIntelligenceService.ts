import { randomUUID } from "node:crypto";
import * as analyticsData from "@/lib/content/analyticsData";
import { getPagesForPeriod, getPagesForPeriodWithCredentials } from "@/lib/admin/ga4";
import { enqueueDeliveryJob } from "@/lib/operations/deliveryJobService";
import { logPlatformEventFor } from "@/lib/platform/audit";
import { resolveConnectionCredentials } from "@/lib/infrastructure/credentialProvider";

const DAY = 86_400_000;
const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function periodEndingYesterday(days: number, offsetDays = 0) {
  const end = new Date(Date.now() - (1 + offsetDays) * DAY);
  const start = new Date(end.getTime() - (days - 1) * DAY);
  return { start: isoDate(start), end: isoDate(end) };
}

/** The workspace's GA4 connector (created when missing), without its encrypted config. */
export async function ensureWorkspaceGa4Connector(params: { workspaceId: string; actorId: string }) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the encrypted config never leaves the server
  const { config_json_encrypted, ...connector } = await analyticsData.ensureGa4Connector(params.workspaceId, params.actorId);
  return connector;
}

export async function getAnalyticsOverview(workspaceId: string) {
  return analyticsData.overviewRows(workspaceId);
}

export async function queueAnalyticsSync(params: { workspaceId: string; actorId: string; connectorId: string }) {
  const connector = UUID.test(params.connectorId) ? await analyticsData.connectorById(params.workspaceId, params.connectorId) : null;
  if (!connector?.active) throw new Error("Active analytics connector not found");
  const freshThrough = periodEndingYesterday(28).end;
  const correlationId = randomUUID();
  const job = await enqueueDeliveryJob({
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    kind: "analytics_sync",
    idempotencyKey: `analytics:${connector.id}:${freshThrough}`,
    payload: { connectorId: connector.id, freshThrough },
    safeMetadata: { provider: connector.provider, connectorId: connector.id, freshThrough },
    queueName: "intelligence",
    correlationId,
    maxAttempts: 3,
  });
  await analyticsData.upsertSyncState({
    connector_id: connector.id,
    workspace_id: params.workspaceId,
    status: "queued",
    correlation_id: correlationId,
    updated_at: new Date().toISOString(),
  });
  await logPlatformEventFor("content", { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "analytics.sync_queued", entityType: "analytics_connector", entityId: connector.id, metadata: { correlationId, freshThrough } });
  return job;
}

export async function runGa4AnalyticsSync(params: { workspaceId: string; connectorId: string; correlationId?: string | null }) {
  const found = UUID.test(params.connectorId) ? await analyticsData.connectorById(params.workspaceId, params.connectorId) : null;
  const connector = found?.provider === "ga4" && found.active ? found : null;
  if (!connector) throw new Error("Active GA4 connector not found");
  const correlationId = params.correlationId || randomUUID();
  await analyticsData.upsertSyncState({ connector_id: connector.id, workspace_id: params.workspaceId, status: "running", last_attempt_at: new Date().toISOString(), correlation_id: correlationId, last_error: null, updated_at: new Date().toISOString() });

  try {
    const pagesFor = async (start: string, end: string) => {
      if (!connector.connection_id) return getPagesForPeriod(start, end);
      const connection = await analyticsData.connectionForSync(params.workspaceId, connector.connection_id);
      if (!connection?.active || connection.status === "disabled") throw new Error("Linked GA4 connection is disabled or unavailable");
      const credentials = await resolveConnectionCredentials(params.workspaceId, connection.id);
      const propertyId = String(connection.config_json?.propertyId ?? "").trim();
      if (!propertyId || !credentials.client_email || !credentials.private_key) throw new Error("Linked GA4 connection is missing required configuration or credentials");
      return getPagesForPeriodWithCredentials({ propertyId, clientEmail: credentials.client_email, privateKey: credentials.private_key }, start, end);
    };
    const current = periodEndingYesterday(28);
    const previous = periodEndingYesterday(28, 28);
    const [currentPages, previousPages, { routes, entries }] = await Promise.all([
      pagesFor(current.start, current.end),
      pagesFor(previous.start, previous.end),
      analyticsData.syncTargets(params.workspaceId),
    ]);
    const versionByEntry = new Map(entries.map((entry) => [entry.id, entry.published_version_id]));
    const currentByPath = new Map(currentPages.map((page) => [page.path.replace(/\?.*$/, "").replace(/\/$/, "") || "/", page]));
    const previousByPath = new Map(previousPages.map((page) => [page.path.replace(/\?.*$/, "").replace(/\/$/, "") || "/", page]));
    const snapshots: Array<Record<string, unknown>> = [];
    for (const route of routes) {
      if (!route.entry_id) continue;
      const path = route.path.replace(/\/$/, "") || "/";
      const versionId = versionByEntry.get(route.entry_id) ?? null;
      for (const period of [{ range: current, page: currentByPath.get(path), label: "current_28d" }, { range: previous, page: previousByPath.get(path), label: "previous_28d" }]) {
        const page = period.page;
        snapshots.push({
          workspace_id: params.workspaceId,
          entry_id: route.entry_id,
          version_id: versionId,
          destination_url: path,
          source: "ga4",
          period_start: period.range.start,
          period_end: period.range.end,
          page_views: page?.pageViews ?? 0,
          users_count: page?.users ?? 0,
          engagement_seconds: page?.engagementSeconds ?? 0,
          conversions: null,
          metrics_json: { sessions: page?.sessions ?? 0, pageTitle: page?.title ?? null, comparisonWindow: period.label, interpretation: "observational" },
          connector_id: connector.id,
          sync_correlation_id: correlationId,
          data_fresh_through: current.end,
          captured_at: new Date().toISOString(),
        });
      }
    }
    const written = await analyticsData.writeSyncSnapshots(snapshots);
    await analyticsData.upsertSyncState({ connector_id: connector.id, workspace_id: params.workspaceId, status: "fresh", last_success_at: new Date().toISOString(), fresh_through: current.end, correlation_id: correlationId, last_error: null, updated_at: new Date().toISOString() });
    return { connectorId: connector.id, correlationId, freshThrough: current.end, routes: routes.length, snapshotsWritten: written };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GA4 synchronization failed";
    await analyticsData.upsertSyncState({ connector_id: connector.id, workspace_id: params.workspaceId, status: "failed", last_attempt_at: new Date().toISOString(), correlation_id: correlationId, last_error: message, updated_at: new Date().toISOString() });
    throw error;
  }
}

export async function getEntryPerformanceComparison(workspaceId: string, entryId: string) {
  const rows = UUID.test(entryId) ? await analyticsData.performanceRows(workspaceId, entryId) : [];
  const current = rows.find((row) => row.metrics_json?.comparisonWindow === "current_28d") ?? rows[0] ?? null;
  const previous = rows.find((row) => row.metrics_json?.comparisonWindow === "previous_28d") ?? rows[1] ?? null;
  const pct = (a: number | null, b: number | null) => b && a !== null ? ((a - b) / b) * 100 : null;
  return {
    current,
    previous,
    delta: current && previous ? {
      pageViewsPct: pct(Number(current.page_views ?? 0), Number(previous.page_views ?? 0)),
      usersPct: pct(Number(current.users_count ?? 0), Number(previous.users_count ?? 0)),
      engagementPct: pct(Number(current.engagement_seconds ?? 0), Number(previous.engagement_seconds ?? 0)),
    } : null,
    interpretation: "observational" as const,
    note: "Before/after analytics are observational. They do not establish that the content change caused the measured outcome.",
  };
}
