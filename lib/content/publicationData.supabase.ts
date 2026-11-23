// Supabase path of the publication target and job reads and writes (queries moved unchanged from
// publicationService.ts; deleted with the switch at the end of phase 1). Config encryption,
// validation, signing, the delivery request and the retry rules stay in publicationService.ts.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { enqueueDeliveryJob } from "@/lib/operations/deliveryJobService";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the service reads them */
export type TargetSummary = { id: string; name: string; target_type: string; active: boolean; created_at: string };
export type DispatchJob = {
  id: string; workspace_id: string; target_id: string; entry_id: string | null; version_id: string | null; release_id: string | null; idempotency_key: string; status: string; attempt_count: number; max_attempts: number;
  [key: string]: unknown;
  publication_targets: { config_json_encrypted: string; active: boolean };
};
export type JobOutcome = {
  log: { attempt_number: number; status_code?: number; outcome: string; detail: string | null };
  job: Record<string, unknown>;
  health: { p_workspace_id: string; p_destination_kind: string; p_destination_id: string; p_success: boolean; p_latency_ms: number; p_error_code: string | null; p_error_message: string | null; p_disabled: boolean };
};

export async function listTargets(workspaceId: string): Promise<any[]> {
  const { data } = await createServiceRoleClient()
    .from("publication_targets")
    .select("id, name, target_type, active, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  return data ?? [];
}

export async function insertTarget(row: Record<string, unknown>, auditFor: (target: TargetSummary) => PlatformAuditPayload): Promise<TargetSummary> {
  const { data, error } = await createServiceRoleClient().from("publication_targets").insert(row).select("id, name, target_type, active, created_at").single();
  if (error || !data) throw new Error(error?.message || "Could not create publication target");
  await logPlatformEvent(auditFor(data as TargetSummary));
  return data as TargetSummary;
}

/** One job per active target of the workspace, each with its delivery job; returns the new jobs. */
export async function queueJobs(params: { workspaceId: string; actorId: string; entryId: string; versionId: string }, correlationId: string): Promise<any[]> {
  const db = createServiceRoleClient();
  const { data: targets } = await db.from("publication_targets").select("id").eq("workspace_id", params.workspaceId).eq("active", true);
  const jobs = await Promise.all(
    (targets ?? []).map(async (target) => {
      const idempotencyKey = `entry:${params.entryId}:version:${params.versionId}:target:${target.id}`;
      const { data, error } = await db
        .from("publication_jobs")
        .insert({ workspace_id: params.workspaceId, target_id: target.id, entry_id: params.entryId, version_id: params.versionId, idempotency_key: idempotencyKey })
        .select()
        .single();
      if (error?.code === "23505") return null;
      if (error) throw new Error(error.message);
      await enqueueDeliveryJob({
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        kind: "publish",
        idempotencyKey: `publication-job:${data.id}`,
        correlationId,
        payload: { publicationJobId: data.id },
        safeMetadata: { publicationJobId: data.id, targetId: target.id, entryId: params.entryId, versionId: params.versionId },
      });
      return data;
    })
  );
  return jobs.filter(Boolean);
}

export async function listJobs(workspaceId: string, entryId?: string): Promise<any[]> {
  let query = createServiceRoleClient()
    .from("publication_jobs")
    .select("*, publication_targets(name, target_type)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (entryId) query = query.eq("entry_id", entryId);
  const { data } = await query;
  return data ?? [];
}

export async function jobForDispatch(workspaceId: string, jobId: string): Promise<DispatchJob | null> {
  const { data: job } = await createServiceRoleClient()
    .from("publication_jobs")
    .select("*, publication_targets!inner(config_json_encrypted, active)")
    .eq("workspace_id", workspaceId)
    .eq("id", jobId)
    .maybeSingle();
  return (job as DispatchJob | null) ?? null;
}

export async function markJobRunning(workspaceId: string, jobId: string, attempt: number): Promise<void> {
  void workspaceId; // the caller read the job in the workspace
  await createServiceRoleClient()
    .from("publication_jobs")
    .update({ status: "running", attempt_count: attempt, started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/** Records how an attempt ended: the delivery log, the job and destination health. */
export async function recordJobOutcome(workspaceId: string, jobId: string, outcome: JobOutcome): Promise<void> {
  void workspaceId; // the caller read the job in the workspace
  const db = createServiceRoleClient();
  await db.from("publication_delivery_logs").insert({ job_id: jobId, ...outcome.log });
  await db.from("publication_jobs").update(outcome.job).eq("id", jobId);
  await db.rpc("cms_record_destination_health", outcome.health);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
