import { createHash } from "node:crypto";
import { listEntries } from "@/lib/content/entryService";
import { getLocalizationStatus } from "@/lib/content/localizationService";
import { runEntryPreflight } from "@/lib/content/preflightService";
import { getAssetUsageGraph, getImpact } from "@/lib/content/impactGraphService";
import { getEntryPerformanceComparison } from "@/lib/content/analyticsIntelligenceService";
import { enqueueDeliveryJob } from "@/lib/operations/deliveryJobService";
import { logPlatformEventFor } from "@/lib/platform/audit";
import * as healthData from "@/lib/content/healthData";

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_STATUSES = new Set(["open", "in_progress", "done", "dismissed"]);
const TASK_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

/** Input checks shared by both paths: malformed ids read as "not found", unknown values are refused. */
function checkTaskInput(params: { findingId?: string | null; entityType?: "entry" | "asset"; entityId?: string; assignedTo?: string | null; status?: string; priority?: string; dueAt?: string | null }) {
  if (params.findingId && !UUID.test(params.findingId)) throw new Error("Health finding not found in workspace");
  if (params.entityId !== undefined && !UUID.test(params.entityId)) throw new Error(params.entityType === "asset" ? "Asset not found in workspace" : "Entry not found in workspace");
  if (params.assignedTo && !UUID.test(params.assignedTo)) throw new Error("Assignee must be an active workspace member");
  if (params.status !== undefined && !TASK_STATUSES.has(params.status)) throw new Error("Unsupported remediation task status");
  if (params.priority !== undefined && !TASK_PRIORITIES.has(params.priority)) throw new Error("Unsupported remediation task priority");
  if (params.dueAt && Number.isNaN(Date.parse(params.dueAt))) throw new Error("Due date is not a valid date");
}
const fingerprint = (...parts: string[]) => createHash("sha256").update(parts.join(":"), "utf8").digest("hex");

type FindingInput = {
  entityType: "entry" | "asset";
  entityId: string;
  code: string;
  severity: "info" | "warning" | "blocking";
  title: string;
  detail?: string | null;
  evidence?: Record<string, unknown>;
};

async function upsertFinding(workspaceId: string, finding: FindingInput) {
  return healthData.callUpsertHealthFinding({
    p_workspace_id: workspaceId,
    p_entity_type: finding.entityType,
    p_entity_id: finding.entityId,
    p_finding_code: finding.code,
    p_severity: finding.severity,
    p_fingerprint: fingerprint(finding.entityType, finding.entityId, finding.code),
    p_title: finding.title,
    p_detail: finding.detail ?? null,
    p_evidence: finding.evidence ?? {},
  });
}

export async function scanContentHealth(params: { workspaceId: string; actorId?: string | null }) {
  const [entries, { profiles, assets }] = await Promise.all([
    listEntries(params.workspaceId),
    healthData.scanRows(params.workspaceId),
  ]);
  const now = Date.now();
  const detected = new Set<string>();
  let findingsWritten = 0;

  const emit = async (finding: FindingInput) => {
    detected.add(fingerprint(finding.entityType, finding.entityId, finding.code));
    await upsertFinding(params.workspaceId, finding);
    findingsWritten += 1;
  };

  for (const entry of entries) {
    const profile = profiles.find((item) => item.entry_id === entry.id);
    if (!profile?.owner_id) await emit({ entityType: "entry", entityId: entry.id, code: "missing_owner", severity: "warning", title: "Content has no owner", detail: "Assign an accountable owner so review and remediation work has a clear destination." });

    if (profile?.review_cadence_days) {
      if (!profile.last_reviewed_at) {
        await emit({ entityType: "entry", entityId: entry.id, code: "review_never_completed", severity: "warning", title: "Review cadence exists but no review is recorded", evidence: { cadenceDays: profile.review_cadence_days } });
      } else if (new Date(profile.last_reviewed_at).getTime() + Number(profile.review_cadence_days) * DAY < now) {
        await emit({ entityType: "entry", entityId: entry.id, code: "review_overdue", severity: "warning", title: "Content review is overdue", evidence: { lastReviewedAt: profile.last_reviewed_at, cadenceDays: profile.review_cadence_days } });
      }
    }
    if (profile?.expires_at && new Date(profile.expires_at).getTime() < now) await emit({ entityType: "entry", entityId: entry.id, code: "expired", severity: "blocking", title: "Content has expired", evidence: { expiresAt: profile.expires_at } });

    const [preflight, locales, impact, performance] = await Promise.all([
      runEntryPreflight(params.workspaceId, entry.id),
      getLocalizationStatus(params.workspaceId, entry.id),
      getImpact(params.workspaceId, entry.id),
      getEntryPerformanceComparison(params.workspaceId, entry.id).catch(() => null),
    ]);

    if ((preflight?.summary.blocking ?? 0) > 0) await emit({ entityType: "entry", entityId: entry.id, code: "publish_blocked", severity: "blocking", title: "Publish assurance is blocked", detail: `${preflight?.summary.blocking ?? 0} blocking preflight issue(s) remain.`, evidence: { blocking: preflight?.summary.blocking ?? 0, warnings: preflight?.summary.warnings ?? 0 } });
    else if ((preflight?.summary.warnings ?? 0) > 0) await emit({ entityType: "entry", entityId: entry.id, code: "metadata_or_quality_warnings", severity: "warning", title: "Publish assurance has warnings", detail: `${preflight?.summary.warnings ?? 0} warning(s) remain.`, evidence: { warnings: preflight?.summary.warnings ?? 0 } });

    const staleLocales = (locales ?? []).filter((item) => item.status === "stale" || item.status === "needs_review" || (item.required && item.status === "missing"));
    if (staleLocales.length) await emit({ entityType: "entry", entityId: entry.id, code: "localization_stale", severity: staleLocales.some((item) => item.required) ? "blocking" : "warning", title: "Translation readiness needs attention", evidence: { locales: staleLocales.map((item) => ({ locale: item.locale, status: item.status, required: item.required })) } });

    if ((impact?.publishedDependents ?? 0) > 0 || (impact?.releaseIds.length ?? 0) > 0) await emit({ entityType: "entry", entityId: entry.id, code: "dependency_risk", severity: "info", title: "Content has an active blast radius", detail: "Changes affect published dependents or active release bundles.", evidence: { publishedDependents: impact?.publishedDependents ?? 0, releaseCount: impact?.releaseIds.length ?? 0, totalImpact: impact?.totalImpact ?? 0 } });

    const pageDelta = performance?.delta?.pageViewsPct;
    const engagementDelta = performance?.delta?.engagementPct;
    if ((pageDelta !== null && pageDelta !== undefined && pageDelta <= -25) || (engagementDelta !== null && engagementDelta !== undefined && engagementDelta <= -25)) {
      await emit({ entityType: "entry", entityId: entry.id, code: "performance_decline", severity: "warning", title: "Observed performance declined", detail: "The latest 28-day window is materially lower than the previous 28-day window. This is observational, not proof of causality.", evidence: { pageViewsPct: pageDelta, engagementPct: engagementDelta, interpretation: "observational", freshThrough: performance?.current?.data_fresh_through ?? null } });
    }
  }

  for (const asset of assets) {
    const usage = await getAssetUsageGraph(params.workspaceId, asset.id);
    if (usage.length === 0) await emit({ entityType: "asset", entityId: asset.id, code: "unused_asset", severity: "info", title: "Media asset is unused", detail: asset.filename, evidence: { filename: asset.filename, mimeType: asset.mime_type } });
  }

  const resolved = await healthData.resolveUndetected(params.workspaceId, detected);

  if (params.actorId) await logPlatformEventFor("content", { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "content_health.scan_completed", entityType: "workspace", entityId: params.workspaceId, metadata: { entries: entries.length, assets: assets.length, findingsWritten, resolved } });
  return { entries: entries.length, assets: assets.length, findingsWritten, resolved };
}

export async function queueContentHealthScan(params: { workspaceId: string; actorId: string }) {
  const bucket = new Date().toISOString().slice(0, 13);
  return enqueueDeliveryJob({ workspaceId: params.workspaceId, actorId: params.actorId, kind: "health_scan", idempotencyKey: `health:${params.workspaceId}:${bucket}`, payload: { workspaceId: params.workspaceId }, safeMetadata: { scope: "workspace" }, queueName: "intelligence", maxAttempts: 3 });
}

export async function getContentHealth(workspaceId: string) {
  const { findings, tasks, profiles } = await healthData.overviewRows(workspaceId);
  const open = findings.filter((item) => ["open", "acknowledged"].includes(item.state));
  return {
    summary: {
      blocking: open.filter((item) => item.severity === "blocking").length,
      warnings: open.filter((item) => item.severity === "warning").length,
      info: open.filter((item) => item.severity === "info").length,
      openTasks: tasks.filter((item) => ["open", "in_progress"].includes(item.status)).length,
      missingOwner: open.filter((item) => item.finding_code === "missing_owner").length,
      overdueReview: open.filter((item) => ["review_overdue", "review_never_completed"].includes(item.finding_code)).length,
      expired: open.filter((item) => item.finding_code === "expired").length,
      staleLocales: open.filter((item) => item.finding_code === "localization_stale").length,
      unusedAssets: open.filter((item) => item.finding_code === "unused_asset").length,
      performanceDecline: open.filter((item) => item.finding_code === "performance_decline").length,
    },
    findings,
    tasks,
    profiles,
  };
}

export async function createRemediationTask(params: { workspaceId: string; actorId: string; findingId?: string | null; entityType: "entry" | "asset"; entityId: string; title: string; priority?: string; assignedTo?: string | null; dueAt?: string | null }) {
  if (!params.title.trim()) throw new Error("Task title is required");
  checkTaskInput(params);
  return healthData.insertRemediationTask({
    workspace_id: params.workspaceId,
    finding_id: params.findingId ?? null,
    entity_type: params.entityType,
    entity_id: params.entityId,
    title: params.title.trim(),
    priority: params.priority ?? "normal",
    assigned_to: params.assignedTo ?? null,
    due_at: params.dueAt ?? null,
    created_by: params.actorId,
  }, (task) => ({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "content_health.remediation_created", entityType: "content_remediation_task", entityId: task.id, metadata: { findingId: params.findingId ?? null, entityType: params.entityType, entityId: params.entityId } }));
}

export async function updateRemediationTask(params: { workspaceId: string; actorId: string; id: string; status?: string; priority?: string; assignedTo?: string | null; dueAt?: string | null; resolutionNote?: string | null }) {
  if (!UUID.test(params.id)) throw new Error("Remediation task not found");
  checkTaskInput(params);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.status !== undefined) patch.status = params.status;
  if (params.priority !== undefined) patch.priority = params.priority;
  if (params.assignedTo !== undefined) patch.assigned_to = params.assignedTo;
  if (params.dueAt !== undefined) patch.due_at = params.dueAt;
  if (params.resolutionNote !== undefined) patch.resolution_note = params.resolutionNote;
  if (params.status === "done") Object.assign(patch, { completed_by: params.actorId, completed_at: new Date().toISOString() });
  const data = await healthData.updateRemediationTaskRow(params.workspaceId, params.id, patch, (task) => ({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "content_health.remediation_updated", entityType: "content_remediation_task", entityId: params.id, metadata: { status: params.status ?? task.status } }));
  if (!data) throw new Error("Remediation task not found");
  return data;
}


export async function updateContentHealthProfile(params: {
  workspaceId: string; actorId: string; entryId: string; ownerId?: string | null; reviewCadenceDays?: number | null; lastReviewedAt?: string | null; expiresAt?: string | null;
}) {
  if (!UUID.test(params.entryId)) throw new Error("Entry not found in workspace");
  if (params.ownerId && !UUID.test(params.ownerId)) throw new Error("Owner must be an active workspace member");
  return healthData.callUpsertHealthProfile({
    p_workspace_id: params.workspaceId, p_actor_id: params.actorId, p_entry_id: params.entryId,
    p_owner_id: params.ownerId ?? null, p_review_cadence_days: params.reviewCadenceDays ?? null,
    p_last_reviewed_at: params.lastReviewedAt ?? null, p_expires_at: params.expiresAt ?? null,
  });
}
