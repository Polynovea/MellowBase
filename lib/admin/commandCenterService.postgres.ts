// Direct PostgreSQL gatherer for the Command Center (phase 1, wave 2).
//
// Same result as commandCenterService.supabase.ts, which ran 26 separate count requests: here each
// table is read once with `count(*) filter (...)` per figure, ten queries in all. Every query is
// scoped by workspace_id. Analytics stays optional, as before: if its table cannot be read, its
// count is 0 rather than failing the page.
import { sql } from "kysely";
import { getDb } from "@/lib/db/index";
import type { CommandCenterData } from "@/lib/admin/commandCenterService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Counts = Record<string, number>;

async function counts(query: ReturnType<typeof sql<Counts>>): Promise<Counts> {
  const { rows } = await query.execute(getDb());
  return rows[0] ?? {};
}

export async function gatherCommandCenterData(workspaceId: string, actorId: string): Promise<CommandCenterData> {
  const db = getDb();
  const actor = UUID.test(actorId) ? actorId : null;

  const [models, entries, assets, releases, jobs, findings, assignments, approvals, environments, connections, analytics] = await Promise.all([
    counts(sql<Counts>`select count(*) filter (where status = 'active') as models from content_models where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`
      select count(*) filter (where status <> 'archived') as entries,
             count(*) filter (where status = 'draft') as draft,
             count(*) filter (where status = 'in_review') as review,
             count(*) filter (where status = 'approved') as approved,
             count(*) filter (where status = 'scheduled') as scheduled,
             count(*) filter (where status = 'published') as published
      from content_entries where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`select count(*) filter (where archived_at is null) as assets from assets where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`
      select count(*) filter (where status in ('draft', 'approved', 'scheduled', 'publishing')) as open,
             count(*) filter (where status = 'scheduled') as scheduled,
             count(*) filter (where status = 'partially_failed') as failed
      from releases where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`
      select count(*) filter (where status in ('queued', 'retrying')) as queued,
             count(*) filter (where status = 'running') as running,
             count(*) filter (where status = 'dead_letter') as dead
      from delivery_jobs where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`
      select count(*) filter (where state in ('open', 'acknowledged')) as open,
             count(*) filter (where state in ('open', 'acknowledged') and severity = 'blocking') as blocking,
             count(*) filter (where state in ('open', 'acknowledged') and severity = 'warning') as warning
      from content_health_findings where workspace_id = ${workspaceId}`),
    actor
      ? counts(sql<Counts>`select count(*) as active from content_assignments where workspace_id = ${workspaceId} and assigned_to_admin_user_id = ${actor} and status = 'active'`)
      : Promise.resolve({ active: 0 }),
    counts(sql<Counts>`select count(*) filter (where status = 'pending') as pending from infrastructure_approval_requests where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`
      select count(*) as total,
             count(*) filter (where status = 'ready') as ready,
             count(*) filter (where status in ('degraded', 'blocked')) as problem
      from workspace_environments where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`
      select count(*) filter (where active) as total,
             count(*) filter (where active and status = 'active') as active,
             count(*) filter (where active and status in ('degraded', 'failed')) as problem
      from workspace_connections where workspace_id = ${workspaceId}`),
    counts(sql<Counts>`select count(*) filter (where status in ('stale', 'failed')) as problems from analytics_sync_state where workspace_id = ${workspaceId}`)
      .catch(() => ({ problems: 0 })),
  ]);

  const [environmentList, recentAudit, recentJobs, recentFindings, recentReleases] = await Promise.all([
    db.selectFrom("workspace_environments")
      .select(["id", "key", "name", "kind", "status", "is_default", "health_json", "last_health_check_at", "deployed_schema_revision"])
      .where("workspace_id", "=", workspaceId)
      .orderBy("is_default", "desc")
      .orderBy("created_at", "asc")
      .limit(200)
      .execute(),
    db.selectFrom("platform_audit_events")
      .select(["id", "action", "entity_type", "entity_id", "metadata_json", "created_at"])
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .limit(10)
      .execute(),
    db.selectFrom("delivery_jobs")
      .select(["id", "kind", "status", "queue_name", "attempt_count", "max_attempts", "last_error_code", "last_error_message", "created_at", "updated_at"])
      .where("workspace_id", "=", workspaceId)
      .orderBy("updated_at", "desc")
      .limit(6)
      .execute(),
    db.selectFrom("content_health_findings")
      .select(["id", "severity", "state", "title", "detail", "entity_type", "entity_id", "last_detected_at"])
      .where("workspace_id", "=", workspaceId)
      .where("state", "in", ["open", "acknowledged"])
      .orderBy("last_detected_at", "desc")
      .limit(6)
      .execute(),
    db.selectFrom("releases")
      .select(["id", "name", "status", "scheduled_for", "published_at", "updated_at"])
      .where("workspace_id", "=", workspaceId)
      .orderBy("updated_at", "desc")
      .limit(6)
      .execute(),
  ]);

  const n = (value: unknown) => Number(value ?? 0);
  return {
    counts: {
      models: n(models.models),
      entries: n(entries.entries),
      draftEntries: n(entries.draft),
      reviewEntries: n(entries.review),
      approvedEntries: n(entries.approved),
      scheduledEntries: n(entries.scheduled),
      publishedEntries: n(entries.published),
      assets: n(assets.assets),
      releasesOpen: n(releases.open),
      releasesScheduled: n(releases.scheduled),
      releasesFailed: n(releases.failed),
      jobsQueued: n(jobs.queued),
      jobsRunning: n(jobs.running),
      jobsDead: n(jobs.dead),
      findingsOpen: n(findings.open),
      findingsBlocking: n(findings.blocking),
      findingsWarning: n(findings.warning),
      assignmentsActive: n(assignments.active),
      approvalsPending: n(approvals.pending),
      environmentsTotal: n(environments.total),
      environmentsReady: n(environments.ready),
      environmentsProblem: n(environments.problem),
      connectionsTotal: n(connections.total),
      connectionsActive: n(connections.active),
      connectionsProblem: n(connections.problem),
      analyticsProblems: n(analytics.problems),
    },
    environments: environmentList,
    recentAudit,
    recentJobs,
    recentFindings,
    recentReleases,
  };
}
