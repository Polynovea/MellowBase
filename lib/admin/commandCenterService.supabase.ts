// Supabase path of the Command Center data (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

import type { CommandCenterData } from "@/lib/admin/commandCenterService";

async function countRows(
  db: ReturnType<typeof createServiceRoleClient>,
  table: string,
  workspaceId: string,
  apply?: (query: any) => any,
) {
  let query: any = db.from(table).select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId);
  if (apply) query = apply(query);
  const { count, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

export async function gatherCommandCenterData(workspaceId: string, actorId: string): Promise<CommandCenterData> {
  const db = createServiceRoleClient();

  const [
    models,
    entries,
    draftEntries,
    reviewEntries,
    approvedEntries,
    scheduledEntries,
    publishedEntries,
    assets,
    releasesOpen,
    releasesScheduled,
    releasesFailed,
    jobsQueued,
    jobsRunning,
    jobsDead,
    findingsOpen,
    findingsBlocking,
    findingsWarning,
    assignmentsActive,
    approvalsPending,
    environmentsTotal,
    environmentsReady,
    environmentsProblem,
    connectionsTotal,
    connectionsActive,
    connectionsProblem,
    analyticsProblems,
  ] = await Promise.all([
    countRows(db, "content_models", workspaceId, (q) => q.eq("status", "active")),
    countRows(db, "content_entries", workspaceId, (q) => q.neq("status", "archived")),
    countRows(db, "content_entries", workspaceId, (q) => q.eq("status", "draft")),
    countRows(db, "content_entries", workspaceId, (q) => q.eq("status", "in_review")),
    countRows(db, "content_entries", workspaceId, (q) => q.eq("status", "approved")),
    countRows(db, "content_entries", workspaceId, (q) => q.eq("status", "scheduled")),
    countRows(db, "content_entries", workspaceId, (q) => q.eq("status", "published")),
    countRows(db, "assets", workspaceId, (q) => q.is("archived_at", null)),
    countRows(db, "releases", workspaceId, (q) => q.in("status", ["draft", "approved", "scheduled", "publishing"])),
    countRows(db, "releases", workspaceId, (q) => q.eq("status", "scheduled")),
    countRows(db, "releases", workspaceId, (q) => q.eq("status", "partially_failed")),
    countRows(db, "delivery_jobs", workspaceId, (q) => q.in("status", ["queued", "retrying"])),
    countRows(db, "delivery_jobs", workspaceId, (q) => q.eq("status", "running")),
    countRows(db, "delivery_jobs", workspaceId, (q) => q.eq("status", "dead_letter")),
    countRows(db, "content_health_findings", workspaceId, (q) => q.in("state", ["open", "acknowledged"])),
    countRows(db, "content_health_findings", workspaceId, (q) => q.in("state", ["open", "acknowledged"]).eq("severity", "blocking")),
    countRows(db, "content_health_findings", workspaceId, (q) => q.in("state", ["open", "acknowledged"]).eq("severity", "warning")),
    countRows(db, "content_assignments", workspaceId, (q) => q.eq("assigned_to_admin_user_id", actorId).eq("status", "active")),
    countRows(db, "infrastructure_approval_requests", workspaceId, (q) => q.eq("status", "pending")),
    countRows(db, "workspace_environments", workspaceId),
    countRows(db, "workspace_environments", workspaceId, (q) => q.eq("status", "ready")),
    countRows(db, "workspace_environments", workspaceId, (q) => q.in("status", ["degraded", "blocked"])),
    countRows(db, "workspace_connections", workspaceId, (q) => q.eq("active", true)),
    countRows(db, "workspace_connections", workspaceId, (q) => q.eq("active", true).eq("status", "active")),
    countRows(db, "workspace_connections", workspaceId, (q) => q.eq("active", true).in("status", ["degraded", "failed"])),
    // Analytics is optional. A stale PostgREST schema cache or an install that
    // has not enabled analytics must not take the whole command center down.
    countRows(db, "analytics_sync_state", workspaceId, (q) => q.in("status", ["stale", "failed"]))
      .catch(() => 0),
  ]);

  // Every list ends with an id tie-break: rows written in one statement share their timestamps, and
  // without it their order (and which of them make the limit) was undefined.
  const [environmentResult, auditResult, jobsResult, findingsResult, releasesResult] = await Promise.all([
    db.from("workspace_environments")
      .select("id,key,name,kind,status,is_default,health_json,last_health_check_at,deployed_schema_revision")
      .eq("workspace_id", workspaceId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    db.from("platform_audit_events")
      .select("id,action,entity_type,entity_id,metadata_json,created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(10),
    db.from("delivery_jobs")
      .select("id,kind,status,queue_name,attempt_count,max_attempts,last_error_code,last_error_message,created_at,updated_at")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(6),
    db.from("content_health_findings")
      .select("id,severity,state,title,detail,entity_type,entity_id,last_detected_at")
      .eq("workspace_id", workspaceId)
      .in("state", ["open", "acknowledged"])
      .order("last_detected_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(6),
    db.from("releases")
      .select("id,name,status,scheduled_for,published_at,updated_at")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(6),
  ]);

  for (const result of [environmentResult, auditResult, jobsResult, findingsResult, releasesResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  return {
    counts: {
      models, entries, draftEntries, reviewEntries, approvedEntries, scheduledEntries, publishedEntries, assets,
      releasesOpen, releasesScheduled, releasesFailed, jobsQueued, jobsRunning, jobsDead,
      findingsOpen, findingsBlocking, findingsWarning, assignmentsActive, approvalsPending,
      environmentsTotal, environmentsReady, environmentsProblem, connectionsTotal, connectionsActive, connectionsProblem,
      analyticsProblems,
    },
    environments: environmentResult.data ?? [],
    recentAudit: auditResult.data ?? [],
    recentJobs: jobsResult.data ?? [],
    recentFindings: findingsResult.data ?? [],
    recentReleases: releasesResult.data ?? [],
  };
}
