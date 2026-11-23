import * as analyticsData from "@/lib/content/analyticsData";
import { getEntry } from "@/lib/content/entryService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const count = (value: unknown, name: string) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
};

/**
 * Records one analytics snapshot for an entry (the caller resolved the entry in the workspace). The
 * version, when given, must be one of the entry's own versions, and the request's values are
 * checked before they reach the database.
 */
export async function recordContentAnalytics(params: { workspaceId: string; entryId: string; versionId?: string | null; destinationUrl: string; source?: string; periodStart: string; periodEnd: string; pageViews?: number; users?: number; engagementSeconds?: number; conversions?: number; metrics?: Record<string, unknown> }) {
  if (typeof params.destinationUrl !== "string" || !params.destinationUrl.trim() || params.destinationUrl.length > 2048) throw new Error("A destination URL is required");
  if (params.source !== undefined && (typeof params.source !== "string" || !/^[a-z0-9_.-]{1,40}$/i.test(params.source))) throw new Error("Analytics source is not valid");
  if (typeof params.periodStart !== "string" || typeof params.periodEnd !== "string" || !DATE.test(params.periodStart) || !DATE.test(params.periodEnd) || Number.isNaN(Date.parse(params.periodStart)) || Number.isNaN(Date.parse(params.periodEnd)) || params.periodStart > params.periodEnd) {
    throw new Error("The period must be two dates (YYYY-MM-DD), start not after end");
  }
  if (params.metrics !== undefined && (!params.metrics || typeof params.metrics !== "object" || Array.isArray(params.metrics))) throw new Error("Metrics must be an object");
  if (!(await getEntry(params.workspaceId, params.entryId))) throw new Error("Entry not found");
  if (params.versionId && (!UUID.test(params.versionId) || !(await analyticsData.versionBelongsToEntry(params.workspaceId, params.entryId, params.versionId)))) {
    throw new Error("Version not found for this entry");
  }
  return analyticsData.upsertSnapshot({ workspace_id: params.workspaceId, entry_id: params.entryId, version_id: params.versionId ?? null, destination_url: params.destinationUrl, source: params.source ?? "ga4", period_start: params.periodStart, period_end: params.periodEnd, page_views: count(params.pageViews, "Page views"), users_count: count(params.users, "Users"), engagement_seconds: count(params.engagementSeconds, "Engagement seconds"), conversions: count(params.conversions, "Conversions"), metrics_json: params.metrics ?? {} });
}

export async function getEntryAnalytics(workspaceId: string, entryId: string) {
  return analyticsData.entrySnapshots(workspaceId, entryId);
}
