// Direct PostgreSQL implementation of the publication target and job reads and writes (phase 1,
// wave 3). Same signatures and shapes as publicationData.supabase.ts. Differences that are
// deliberate:
// - Target creation commits with its audit event.
// - Each publication job commits with its delivery job, so a job can no longer exist without the
//   work that runs it.
// - The job list joins targets on the job's workspace and reads every row in a fixed order.
// - Job writes are scoped by workspace_id, and an attempt's outcome (delivery log, job, destination
//   health) commits as one.
import { getDb, callFunction, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { DispatchJob, JobOutcome, TargetSummary } from "@/lib/content/publicationData.supabase";

export type { DispatchJob, JobOutcome, TargetSummary } from "@/lib/content/publicationData.supabase";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listTargets(workspaceId: string): Promise<any[]> {
  return getDb().selectFrom("publication_targets").select(["id", "name", "target_type", "active", "created_at", "updated_at"])
    .where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute();
}

export async function insertTarget(row: Record<string, unknown>, auditFor: (target: TargetSummary) => PlatformAuditPayload): Promise<TargetSummary> {
  try {
    return await withTransaction(async (trx) => {
      const target = await trx.insertInto("publication_targets").values(row as any)
        .returning(["id", "name", "target_type", "active", "created_at"]).executeTakeFirstOrThrow();
      await recordPlatformEvent(trx, auditFor(target));
      return target;
    });
  } catch (error) {
    throw new Error(clientErrorMessage(error, "Could not create publication target"));
  }
}

export async function queueJobs(params: { workspaceId: string; actorId: string; entryId: string; versionId: string }, correlationId: string): Promise<any[]> {
  return withTransaction(async (trx) => {
    const targets = await trx.selectFrom("publication_targets").select("id").where("workspace_id", "=", params.workspaceId).where("active", "=", true).orderBy("id").execute();
    const jobs: any[] = [];
    for (const target of targets) {
      const job = await trx.insertInto("publication_jobs")
        .values({ workspace_id: params.workspaceId, target_id: target.id, entry_id: params.entryId, version_id: params.versionId, idempotency_key: `entry:${params.entryId}:version:${params.versionId}:target:${target.id}` })
        .onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing())
        .returningAll().executeTakeFirst();
      if (!job) continue; // already queued for this entry version and target
      await callFunction("cms_enqueue_delivery_job", {
        p_workspace_id: params.workspaceId,
        p_actor_id: params.actorId,
        p_kind: "publish",
        p_idempotency_key: `publication-job:${job.id}`,
        p_payload: { publicationJobId: job.id },
        p_safe_metadata: { publicationJobId: job.id, targetId: target.id, entryId: params.entryId, versionId: params.versionId },
        p_run_after: new Date().toISOString(),
        p_priority: 100,
        p_max_attempts: 5,
        p_queue_name: "default",
        p_correlation_id: correlationId,
      }, trx);
      jobs.push(job);
    }
    return jobs;
  });
}

export async function listJobs(workspaceId: string, entryId?: string): Promise<any[]> {
  if (entryId !== undefined && !UUID.test(entryId)) return [];
  let query = getDb().selectFrom("publication_jobs as j")
    .leftJoin("publication_targets as t", (join) => join.onRef("t.id", "=", "j.target_id").onRef("t.workspace_id", "=", "j.workspace_id"))
    .selectAll("j").select(["t.id as t_id", "t.name as t_name", "t.target_type as t_target_type"])
    .where("j.workspace_id", "=", workspaceId);
  if (entryId) query = query.where("j.entry_id", "=", entryId);
  const rows = await query.orderBy("j.created_at", "desc").orderBy("j.id").execute();
  return rows.map(({ t_id, t_name, t_target_type, ...job }) => ({ ...job, publication_targets: t_id ? { name: t_name, target_type: t_target_type } : null }));
}

export async function jobForDispatch(workspaceId: string, jobId: string): Promise<DispatchJob | null> {
  if (!UUID.test(jobId)) return null;
  const row = await getDb().selectFrom("publication_jobs as j")
    .innerJoin("publication_targets as t", (join) => join.onRef("t.id", "=", "j.target_id").onRef("t.workspace_id", "=", "j.workspace_id"))
    .selectAll("j").select(["t.config_json_encrypted as t_config", "t.active as t_active"])
    .where("j.workspace_id", "=", workspaceId).where("j.id", "=", jobId).executeTakeFirst();
  if (!row) return null;
  const { t_config, t_active, ...job } = row;
  return { ...job, publication_targets: { config_json_encrypted: t_config, active: t_active } } as DispatchJob;
}

export async function markJobRunning(workspaceId: string, jobId: string, attempt: number): Promise<void> {
  const now = new Date().toISOString();
  await getDb().updateTable("publication_jobs").set({ status: "running", attempt_count: attempt, started_at: now, updated_at: now })
    .where("workspace_id", "=", workspaceId).where("id", "=", jobId).execute();
}

export async function recordJobOutcome(workspaceId: string, jobId: string, outcome: JobOutcome): Promise<void> {
  await withTransaction(async (trx) => {
    await trx.insertInto("publication_delivery_logs").values({ job_id: jobId, ...outcome.log }).execute();
    await trx.updateTable("publication_jobs").set(outcome.job as any).where("workspace_id", "=", workspaceId).where("id", "=", jobId).execute();
    await callFunction("cms_record_destination_health", outcome.health as never, trx);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
