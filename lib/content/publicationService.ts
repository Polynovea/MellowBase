import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { decryptConfig, encryptConfig } from "@/lib/content/secureConfig";
import * as publicationData from "@/lib/content/publicationData";
import { logPlatformEvent } from "@/lib/platform/audit";
import { assertSafeOutboundUrl } from "@/lib/infrastructure/networkSafety";
import { guardedFetch } from "@/lib/infrastructure/guardedNetwork";

type TargetConfig = { url: string; headers?: Record<string, string>; signingSecret?: string };

const retryAt = (attempt: number) => new Date(Date.now() + Math.min(3_600_000, 1_000 * 2 ** attempt)).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
// Headers the delivery sets itself; a target's own headers can neither replace nor add them.
const RESERVED_HEADERS = new Set(["content-type", "content-length", "host", "connection", "transfer-encoding", "idempotency-key"]);

/** A target's config arrives from the request body: an HTTPS URL and optional plain string headers. */
function checkTargetConfig(config: unknown): TargetConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("A name and HTTPS destination URL are required");
  const { url, headers, signingSecret } = config as Record<string, unknown>;
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("A name and HTTPS destination URL are required");
  if (signingSecret !== undefined && (typeof signingSecret !== "string" || signingSecret.length < 16 || signingSecret.length > 512)) {
    throw new Error("A signing secret must be 16 to 512 characters");
  }
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Headers must be name and value pairs");
    const entries = Object.entries(headers as Record<string, unknown>);
    if (entries.length > 20) throw new Error("A target may set at most 20 headers");
    for (const [name, value] of entries) {
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(lower) || lower.startsWith("x-polynovea-")) throw new Error(`Header ${name.slice(0, 100)} cannot be set on a publication target`);
      if (typeof value !== "string" || value.length > 4096 || /[\r\n]/.test(value)) throw new Error("Header values must be single-line text");
    }
  }
  return { url, ...(headers ? { headers: headers as Record<string, string> } : {}), ...(signingSecret ? { signingSecret: signingSecret as string } : {}) };
}

export async function listPublicationTargets(workspaceId: string) {
  return publicationData.listTargets(workspaceId);
}

export async function createPublicationTarget(params: {
  workspaceId: string;
  actorId: string;
  name: string;
  targetType: string;
  config: TargetConfig;
}) {
  if (typeof params.name !== "string" || !params.name.trim()) throw new Error("A name and HTTPS destination URL are required");
  if (typeof params.targetType !== "string" || !params.targetType.trim()) throw new Error("A target type is required");
  const config = checkTargetConfig(params.config);
  await assertSafeOutboundUrl(config.url, "production");
  const signingSecret = config.signingSecret || randomBytes(32).toString("base64url");
  const storedConfig: TargetConfig = { ...config, signingSecret };
  const data = await publicationData.insertTarget({
    workspace_id: params.workspaceId,
    name: params.name.trim(),
    target_type: params.targetType,
    config_json_encrypted: encryptConfig(storedConfig),
    created_by: params.actorId,
  }, (target) => ({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "publication.target_created",
    entityType: "publication_target",
    entityId: target.id,
  }));
  return { ...data, signingSecret };
}

export async function queueEntryPublication(params: {
  workspaceId: string;
  actorId: string;
  entryId: string;
  versionId: string;
}) {
  const correlationId = randomUUID();
  const jobs = await publicationData.queueJobs(params, correlationId);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "publication.jobs_queued",
    entityType: "content_entry",
    entityId: params.entryId,
    metadata: { jobs: jobs.length, correlationId },
  });
  return jobs;
}

export async function listPublicationJobs(workspaceId: string, entryId?: string) {
  if (entryId && !UUID.test(entryId)) return [];
  return publicationData.listJobs(workspaceId, entryId || undefined);
}

/**
 * Compatibility dispatcher for the original publication_jobs projection.
 * Phase 10's external worker owns normal execution; this remains useful for
 * manual recovery and existing API compatibility.
 */
export async function dispatchPublicationJob(workspaceId: string, jobId: string) {
  const found = UUID.test(jobId) ? await publicationData.jobForDispatch(workspaceId, jobId) : null;
  if (!found || !found.publication_targets?.active) throw new Error("Active publication job not found");
  // The target's encrypted config is used here and never returned to the caller.
  const { publication_targets: target, ...job } = found;
  if (["succeeded", "cancelled"].includes(job.status)) return job;

  const attempt = job.attempt_count + 1;
  const startedAt = Date.now();
  await publicationData.markJobRunning(workspaceId, job.id, attempt);

  try {
    const config = decryptConfig<TargetConfig>(target.config_json_encrypted);
    const signingSecret = config.signingSecret || process.env.CMS_DELIVERY_SIGNING_SECRET;
    if (!signingSecret) throw new Error("Publication signing secret is not configured");
    const payload = JSON.stringify({
      event: "publication.requested",
      publicationJobId: job.id,
      entryId: job.entry_id,
      versionId: job.version_id,
      releaseId: job.release_id,
    });
    const response = await guardedFetch(config.url, {
      method: "POST",
      headers: {
        // The target's own headers first, so they can never replace the delivery's own.
        ...(config.headers ?? {}),
        "content-type": "application/json",
        "idempotency-key": job.idempotency_key,
        "x-polynovea-publication-job": job.id,
        "x-polynovea-signature": `sha256=${createHmac("sha256", signingSecret).update(payload).digest("hex")}`,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const success = response.ok;
    const status = success ? "succeeded" : attempt >= job.max_attempts ? "failed" : "retrying";
    await publicationData.recordJobOutcome(workspaceId, job.id, {
      log: { attempt_number: attempt, status_code: response.status, outcome: status, detail: success ? null : `Destination returned ${response.status}` },
      job: {
        status,
        completed_at: success ? new Date().toISOString() : null,
        next_attempt_at: success ? null : retryAt(attempt),
        last_error: success ? null : `Destination returned ${response.status}`,
        updated_at: new Date().toISOString(),
      },
      health: {
      p_workspace_id: workspaceId,
      p_destination_kind: "publication_target",
      p_destination_id: job.target_id,
      p_success: success,
      p_latency_ms: Date.now() - startedAt,
      p_error_code: success ? null : `HTTP_${response.status}`,
      p_error_message: success ? null : `Destination returned ${response.status}`,
      p_disabled: false,
      },
    });
    return { ...job, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delivery failed";
    const status = attempt >= job.max_attempts ? "failed" : "retrying";
    await publicationData.recordJobOutcome(workspaceId, job.id, {
      log: { attempt_number: attempt, outcome: status, detail: message },
      job: { status, next_attempt_at: retryAt(attempt), last_error: message, updated_at: new Date().toISOString() },
      health: {
      p_workspace_id: workspaceId,
      p_destination_kind: "publication_target",
      p_destination_id: job.target_id,
      p_success: false,
      p_latency_ms: Date.now() - startedAt,
      p_error_code: "NETWORK_ERROR",
      p_error_message: message,
      p_disabled: false,
      },
    });
    return { ...job, status };
  }
}
