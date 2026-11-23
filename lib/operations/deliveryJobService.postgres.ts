// PostgreSQL implementation of the operations area: delivery jobs (phase 1, wave 1).
//
// The state changes (enqueue, replay, cancel) stay in their SQL functions, which audit and enforce
// the workspace themselves. Deliberate differences from the Supabase path it replaced in phase 1:
// - A job's attempts and audit trail are read only after the job is found in the workspace (the
// Supabase path queried attempts by job ID alone, in parallel, and discarded them if the job was
// in another workspace), and both have explicit limits.
// - Malformed IDs: getDeliveryJob answers "not found", the others throw a fixed message, as the
// Supabase path's errors did after clientErrorMessage.
// - jsonb arguments are serialized explicitly.
import type { Selectable } from "kysely";
import { callFunction, DEFAULT_LIST_LIMIT, getDb, maybeOne, type Database } from "@/lib/db/index";
import type { DeliveryJobKind, DeliveryJobStatus, EnqueueDeliveryJobInput } from "@/lib/operations/deliveryJobService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

export async function enqueueDeliveryJob(input: EnqueueDeliveryJobInput) {
  const data = await callFunction("cms_enqueue_delivery_job", {
    p_workspace_id: input.workspaceId,
    p_actor_id: input.actorId ?? null,
    p_kind: input.kind,
    p_idempotency_key: input.idempotencyKey,
    p_payload: JSON.stringify(input.payload ?? {}),
    p_safe_metadata: JSON.stringify(input.safeMetadata ?? {}),
    p_run_after: input.runAfter ?? new Date().toISOString(),
    p_priority: input.priority ?? 100,
    p_max_attempts: input.maxAttempts ?? 5,
    p_queue_name: input.queueName ?? "default",
    p_correlation_id: input.correlationId ?? null,
  });
  if (!data) throw new Error("Could not enqueue delivery job");
  // cms_enqueue_delivery_job returns the job row as jsonb.
  return data as unknown as Selectable<Database["delivery_jobs"]>;
}

export async function listDeliveryJobs(params: {
  workspaceId: string;
  status?: DeliveryJobStatus;
  kind?: DeliveryJobKind;
  correlationId?: string;
  limit?: number;
}) {
  let query = getDb()
    .selectFrom("delivery_jobs")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId);
  if (params.status) query = query.where("status", "=", params.status);
  if (params.kind) query = query.where("kind", "=", params.kind);
  if (params.correlationId) {
    if (!isUuid(params.correlationId)) throw new Error("Invalid correlation ID");
    query = query.where("correlation_id", "=", params.correlationId);
  }
  return query
    .orderBy("created_at", "desc")
    .limit(Math.min(200, Math.max(1, params.limit ?? 100)))
    .execute();
}

export async function getDeliveryJob(workspaceId: string, jobId: string) {
  if (!isUuid(jobId)) return null;
  const db = getDb();
  const job = maybeOne(await db.selectFrom("delivery_jobs").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", jobId).execute());
  if (!job) return null;
  const [attempts, audit] = await Promise.all([
    db.selectFrom("delivery_job_attempts").selectAll().where("job_id", "=", job.id).orderBy("attempt_number", "desc").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("platform_audit_events")
      .select(["id", "action", "metadata_json", "created_at", "actor_admin_user_id"])
      .where("workspace_id", "=", workspaceId)
      .where("entity_type", "=", "delivery_job")
      .where("entity_id", "=", job.id)
      .orderBy("created_at", "desc")
      .limit(DEFAULT_LIST_LIMIT)
      .execute(),
  ]);
  return { job, attempts, audit };
}

export async function replayDeliveryJob(params: { workspaceId: string; actorId: string; jobId: string }) {
  if (!isUuid(params.jobId)) throw new Error("Could not replay delivery job");
  const data = await callFunction("cms_replay_delivery_job", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorId,
    p_job_id: params.jobId,
  });
  if (!data) throw new Error("Could not replay delivery job");
  return data;
}

export async function cancelDeliveryJob(params: { workspaceId: string; actorId: string; jobId: string }) {
  if (!isUuid(params.jobId)) throw new Error("Could not cancel delivery job");
  const data = await callFunction("cms_cancel_delivery_job", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorId,
    p_job_id: params.jobId,
  });
  if (!data) throw new Error("Could not cancel delivery job");
  return data;
}

export async function listDestinationHealth(workspaceId: string) {
  return getDb()
    .selectFrom("delivery_destination_health")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .orderBy("updated_at", "desc")
    .limit(DEFAULT_LIST_LIMIT)
    .execute();
}
