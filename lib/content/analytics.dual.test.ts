import { describe, expect, it, vi } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { createEntry } from "@/lib/content/entryService";
import { createModel } from "@/lib/schema/modelService";

// GA4 itself is not under test: the current 28-day window has more views than the previous one.
vi.mock("@/lib/admin/ga4", () => ({
  getPagesForPeriod: vi.fn(async (start: string) => {
    const current = new Date(start).getTime() > Date.now() - 40 * 86_400_000;
    return [
      { path: "/live/", pageViews: current ? 150 : 100, users: current ? 60 : 50, engagementSeconds: 30, sessions: 70, title: "Live" },
      { path: "/draft?utm=x", pageViews: 5, users: 2, engagementSeconds: 1, sessions: 2, title: "Draft" },
    ];
  }),
  getPagesForPeriodWithCredentials: vi.fn(async () => []),
}));

const { getEntryAnalytics, recordContentAnalytics } = await import("@/lib/content/analyticsService");
const { ensureWorkspaceGa4Connector, getAnalyticsOverview, getEntryPerformanceComparison, queueAnalyticsSync, runGa4AnalyticsSync } = await import("@/lib/content/analyticsIntelligenceService");

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const make = async (title: string) => {
    const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title }, actorAdminUserId: adminUserId });
    if (!entry.ok) throw new Error(entry.error);
    return { id: entry.data.entry.id, versionId: entry.data.version.id };
  };
  return { workspaceId, adminUserId, make };
}

const snapshotRow = { destinationUrl: "/page", periodStart: "2026-10-01", periodEnd: "2026-10-28" };

describeWithDatabase("content analytics", (backend) => {
  it("records snapshots once per key (also without a version) and only for the workspace's own entries and versions", async () => {
    const { workspaceId, make } = await setup(backend);
    const entry = await make("Tracked");
    const first = await recordContentAnalytics({ workspaceId, entryId: entry.id, ...snapshotRow, pageViews: 10, metrics: { note: "first" } });
    const second = await recordContentAnalytics({ workspaceId, entryId: entry.id, ...snapshotRow, pageViews: 12, metrics: { note: "second" } });
    expect(second).toMatchObject({ id: first.id, version_id: null, page_views: 12, metrics_json: { note: "second" } });
    const versioned = await recordContentAnalytics({ workspaceId, entryId: entry.id, versionId: entry.versionId, ...snapshotRow, pageViews: 3, users: 2, engagementSeconds: 1.5 });
    expect(versioned).toMatchObject({ version_id: entry.versionId, page_views: 3, users_count: 2, engagement_seconds: 1.5 });
    expect(await getEntryAnalytics(workspaceId, entry.id)).toHaveLength(2);

    const other = await setup(backend);
    const foreign = await other.make("Elsewhere");
    await expect(recordContentAnalytics({ workspaceId, entryId: entry.id, versionId: foreign.versionId, ...snapshotRow })).rejects.toThrow("Version not found for this entry");
    await expect(recordContentAnalytics({ workspaceId: other.workspaceId, entryId: entry.id, ...snapshotRow })).rejects.toThrow("Entry not found");
    await expect(recordContentAnalytics({ workspaceId, entryId: entry.id, ...snapshotRow, periodStart: "2026-11-01" })).rejects.toThrow("start not after end");
    await expect(recordContentAnalytics({ workspaceId, entryId: entry.id, ...snapshotRow, pageViews: -1 })).rejects.toThrow("Page views must be a non-negative number");
    expect(await getEntryAnalytics(other.workspaceId, entry.id)).toEqual([]);
  });

  it("creates one GA4 connector, queues and runs a sync, and compares the two windows", async () => {
    const { workspaceId, adminUserId, make } = await setup(backend);
    const live = await make("Live");
    const draft = await make("Draft");
    await backend.query("update content_entries set status = 'published', published_version_id = current_draft_version_id where id = $1", [live.id]);
    await backend.query("insert into content_routes (workspace_id, entry_id, locale, path) values ($1, $2, 'en', '/live'), ($1, $3, 'en', '/draft')", [workspaceId, live.id, draft.id]);

    const connector = await ensureWorkspaceGa4Connector({ workspaceId, actorId: adminUserId });
    expect(connector).toMatchObject({ workspace_id: workspaceId, provider: "ga4", name: "GA4", active: true });
    expect(Object.keys(connector)).not.toContain("config_json_encrypted");
    expect((await ensureWorkspaceGa4Connector({ workspaceId, actorId: adminUserId })).id).toBe(connector.id);

    const other = await backend.createWorkspace();
    await expect(queueAnalyticsSync({ workspaceId: other.workspaceId, actorId: other.adminUserId, connectorId: connector.id })).rejects.toThrow("Active analytics connector not found");
    await expect(runGa4AnalyticsSync({ workspaceId: other.workspaceId, connectorId: connector.id })).rejects.toThrow("Active GA4 connector not found");
    await expect(queueAnalyticsSync({ workspaceId, actorId: adminUserId, connectorId: "nope" })).rejects.toThrow("Active analytics connector not found");
    await queueAnalyticsSync({ workspaceId, actorId: adminUserId, connectorId: connector.id });
    expect((await getAnalyticsOverview(workspaceId)).syncStates[0]).toMatchObject({ connector_id: connector.id, status: "queued" });

    const result = await runGa4AnalyticsSync({ workspaceId, connectorId: connector.id });
    expect(result).toMatchObject({ connectorId: connector.id, routes: 2, snapshotsWritten: 4 });
    await runGa4AnalyticsSync({ workspaceId, connectorId: connector.id }); // a second sync replaces, also for the unpublished entry
    const overview = await getAnalyticsOverview(workspaceId);
    expect(overview.snapshots).toHaveLength(4);
    expect(overview.connectors.map((c) => c.id)).toEqual([connector.id]);
    expect(overview.syncStates[0]).toMatchObject({ status: "fresh", last_error: null });
    expect(overview.snapshots.filter((s) => s.entry_id === draft.id).every((s) => s.version_id === null && s.page_views === 5)).toBe(true);
    expect((await getAnalyticsOverview(other.workspaceId)).snapshots).toEqual([]);

    const comparison = await getEntryPerformanceComparison(workspaceId, live.id);
    expect(comparison.current).toMatchObject({ page_views: 150, version_id: live.versionId });
    expect(comparison.previous).toMatchObject({ page_views: 100 });
    expect(comparison.delta).toMatchObject({ pageViewsPct: 50, usersPct: 20 });
    expect((await getEntryPerformanceComparison(other.workspaceId, live.id)).current).toBeNull();

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and action = 'analytics.sync_queued'", [workspaceId]);
    expect(events).toHaveLength(1);
  });
});
