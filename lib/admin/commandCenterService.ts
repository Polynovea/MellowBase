// Command Center snapshot: the counts and recent rows behind the admin home page.
//
// The data is gathered on Supabase (commandCenterService.supabase.ts) or directly on PostgreSQL
// (commandCenterService.postgres.ts), chosen by the `admin` switch in POLYNOVEA_DATA_BACKEND. The
// readiness and attention rules below are shared, so both paths report the same thing.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/admin/commandCenterService.postgres";
import * as supabase from "@/lib/admin/commandCenterService.supabase";

interface AttentionItem {
  key: string;
  severity: "blocking" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
  count: number;
}

export interface CommandCenterCounts {
  models: number; entries: number; draftEntries: number; reviewEntries: number; approvedEntries: number;
  scheduledEntries: number; publishedEntries: number; assets: number;
  releasesOpen: number; releasesScheduled: number; releasesFailed: number;
  jobsQueued: number; jobsRunning: number; jobsDead: number;
  findingsOpen: number; findingsBlocking: number; findingsWarning: number;
  assignmentsActive: number; approvalsPending: number;
  environmentsTotal: number; environmentsReady: number; environmentsProblem: number;
  connectionsTotal: number; connectionsActive: number; connectionsProblem: number;
  analyticsProblems: number;
}

// Recent rows are passed through to the API as they are.
export interface CommandCenterData {
  counts: CommandCenterCounts;
  environments: any[];
  recentAudit: any[];
  recentJobs: any[];
  recentFindings: any[];
  recentReleases: any[];
}

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("admin") ? direct : supabase);

export async function getCommandCenterSnapshot(workspaceId: string, actorId: string) {
  const data = await impl().gatherCommandCenterData(workspaceId, actorId);
  const {
    models, entries, draftEntries, reviewEntries, approvedEntries, scheduledEntries, publishedEntries, assets,
    releasesOpen, releasesScheduled, releasesFailed, jobsQueued, jobsRunning, jobsDead,
    findingsOpen, findingsBlocking, findingsWarning, assignmentsActive, approvalsPending,
    environmentsTotal, environmentsReady, environmentsProblem, connectionsTotal, connectionsActive, connectionsProblem,
    analyticsProblems,
  } = data.counts;

  const attention: AttentionItem[] = [];
  if (!environmentsTotal) attention.push({ key: "environment-missing", severity: "warning", title: "Finish workspace setup", detail: "No runtime environment is configured yet. Create one to enable provisioning, delivery health and deployment reconciliation.", href: "/admin/environments", count: 1 });
  if (environmentsProblem) attention.push({ key: "environment", severity: "blocking", title: "Environment health", detail: `${environmentsProblem} environment(s) are degraded or blocked.`, href: "/admin/infrastructure", count: environmentsProblem });
  if (connectionsProblem) attention.push({ key: "connection", severity: "blocking", title: "Connection failures", detail: `${connectionsProblem} active connection(s) are degraded or failed.`, href: "/admin/connections", count: connectionsProblem });
  if (jobsDead) attention.push({ key: "dead-letter", severity: "blocking", title: "Dead-letter jobs", detail: `${jobsDead} durable delivery job(s) require intervention.`, href: "/admin/operations", count: jobsDead });
  if (findingsBlocking) attention.push({ key: "assurance-blocking", severity: "blocking", title: "Blocking content findings", detail: `${findingsBlocking} blocking assurance/health finding(s) remain open.`, href: "/admin/assurance", count: findingsBlocking });
  if (approvalsPending) attention.push({ key: "approvals", severity: "warning", title: "Infrastructure approvals", detail: `${approvalsPending} high-risk operation(s) are waiting for review.`, href: "/admin/infrastructure", count: approvalsPending });
  if (reviewEntries) attention.push({ key: "reviews", severity: "info", title: "Editorial review", detail: `${reviewEntries} content item(s) are waiting in review.`, href: "/admin/my-work", count: reviewEntries });
  if (findingsWarning) attention.push({ key: "assurance-warning", severity: "warning", title: "Content health warnings", detail: `${findingsWarning} warning-level finding(s) remain open.`, href: "/admin/assurance", count: findingsWarning });
  if (analyticsProblems) attention.push({ key: "analytics", severity: "warning", title: "Analytics freshness", detail: `${analyticsProblems} analytics synchronization source(s) are stale or failed.`, href: "/admin/intelligence", count: analyticsProblems });

  const blockingCount = attention.filter((item) => item.severity === "blocking").reduce((sum, item) => sum + item.count, 0);
  const warningCount = attention.filter((item) => item.severity === "warning").reduce((sum, item) => sum + item.count, 0);
  const readiness = blockingCount > 0 ? "blocked" : warningCount > 0 ? "attention" : "healthy";
  const defaultEnvironment = data.environments.find((item) => item.is_default) ?? data.environments[0] ?? null;

  return {
    readiness,
    attention,
    content: {
      models,
      entries,
      assets,
      byStatus: {
        draft: draftEntries,
        inReview: reviewEntries,
        approved: approvedEntries,
        scheduled: scheduledEntries,
        published: publishedEntries,
      },
    },
    workflow: {
      myAssignments: assignmentsActive,
      approvalsPending,
    },
    releases: {
      open: releasesOpen,
      scheduled: releasesScheduled,
      partiallyFailed: releasesFailed,
      recent: data.recentReleases,
    },
    delivery: {
      queued: jobsQueued,
      running: jobsRunning,
      deadLetter: jobsDead,
      recent: data.recentJobs,
    },
    assurance: {
      open: findingsOpen,
      blocking: findingsBlocking,
      warnings: findingsWarning,
      recent: data.recentFindings,
    },
    infrastructure: {
      environments: { total: environmentsTotal, ready: environmentsReady, problem: environmentsProblem },
      connections: { total: connectionsTotal, active: connectionsActive, problem: connectionsProblem },
      analyticsProblems,
      defaultEnvironment,
      environmentList: data.environments,
    },
    recentActivity: data.recentAudit,
    generatedAt: new Date().toISOString(),
  };
}
