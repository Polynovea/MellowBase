import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { createEntry } from "@/lib/content/entryService";
import { createModel } from "@/lib/schema/modelService";

// The delivery request itself is not under test: the destination answers with whatever status is queued here.
const responses: number[] = [];
const requests: Array<{ url: string; headers: Record<string, string> }> = [];
vi.mock("@/lib/infrastructure/guardedNetwork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infrastructure/guardedNetwork")>()),
  guardedFetch: vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string> });
    return new Response(null, { status: responses.shift() ?? 200 });
  }),
}));

const { createPublicationTarget, dispatchPublicationJob, listPublicationJobs, listPublicationTargets, queueEntryPublication } = await import("@/lib/content/publicationService");
const URL_OK = "https://93.184.215.14/publish"; // a public address literal, so no DNS lookup

beforeAll(() => {
  vi.stubEnv("CMS_CONFIG_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
});

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title: "Publish me" }, actorAdminUserId: adminUserId });
  if (!entry.ok) throw new Error(entry.error);
  return { workspaceId, adminUserId, entryId: entry.data.entry.id, versionId: entry.data.version.id };
}

describeWithDatabase("publication targets and jobs", (backend) => {
  it("validates and creates targets, queues one job per active target and lists them per workspace", async () => {
    const { workspaceId, adminUserId, entryId, versionId } = await setup(backend);
    const base = { workspaceId, actorId: adminUserId, name: "Site", targetType: "webhook" };
    await expect(createPublicationTarget({ ...base, config: { url: "http://93.184.215.14/x" } })).rejects.toThrow("A name and HTTPS destination URL are required");
    await expect(createPublicationTarget({ ...base, config: undefined as never })).rejects.toThrow("A name and HTTPS destination URL are required");
    await expect(createPublicationTarget({ ...base, config: { url: "https://10.0.0.5/x" } })).rejects.toThrow("Private network destinations");
    await expect(createPublicationTarget({ ...base, config: { url: URL_OK, headers: { "X-Polynovea-Signature": "forged" } } })).rejects.toThrow("cannot be set on a publication target");
    await expect(createPublicationTarget({ ...base, config: { url: URL_OK, headers: { Authorization: "a\r\nb" } } })).rejects.toThrow("Header values must be single-line text");

    const target = await createPublicationTarget({ ...base, name: " Site ", config: { url: URL_OK, headers: { Authorization: "Bearer t" } } });
    expect(target).toMatchObject({ name: "Site", target_type: "webhook", active: true });
    expect(target.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const inactive = await createPublicationTarget({ ...base, name: "Paused", config: { url: URL_OK } });
    await backend.query("update publication_targets set active = false where id = $1", [inactive.id]);
    expect((await listPublicationTargets(workspaceId)).map((t) => t.name).sort()).toEqual(["Paused", "Site"]);

    const jobs = await queueEntryPublication({ workspaceId, actorId: adminUserId, entryId, versionId });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ workspace_id: workspaceId, target_id: target.id, entry_id: entryId, version_id: versionId, status: "queued", idempotency_key: `entry:${entryId}:version:${versionId}:target:${target.id}` });
    expect(await queueEntryPublication({ workspaceId, actorId: adminUserId, entryId, versionId })).toEqual([]); // same version: nothing new
    const delivery = await backend.query<{ kind: string }>("select kind from delivery_jobs where workspace_id = $1 and kind = 'publish'", [workspaceId]);
    expect(delivery).toEqual([{ kind: "publish" }]);

    const listed = await listPublicationJobs(workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: jobs[0].id, publication_targets: { name: "Site", target_type: "webhook" } });
    expect(await listPublicationJobs(workspaceId, entryId)).toHaveLength(1);
    expect(await listPublicationJobs(workspaceId, "nope")).toEqual([]);

    const other = await backend.createWorkspace();
    expect(await listPublicationTargets(other.workspaceId)).toEqual([]);
    expect(await listPublicationJobs(other.workspaceId)).toEqual([]);
    expect(await queueEntryPublication({ workspaceId: other.workspaceId, actorId: other.adminUserId, entryId, versionId })).toEqual([]);

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and action like 'publication.%' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["publication.jobs_queued", "publication.jobs_queued", "publication.target_created", "publication.target_created"]);
  });

  it("dispatches a job without returning the target's config, and records each attempt", async () => {
    const { workspaceId, adminUserId, entryId, versionId } = await setup(backend);
    await createPublicationTarget({ workspaceId, actorId: adminUserId, name: "Site", targetType: "webhook", config: { url: URL_OK, headers: { Authorization: "Bearer t" } } });
    const [job] = await queueEntryPublication({ workspaceId, actorId: adminUserId, entryId, versionId });
    const other = await backend.createWorkspace();
    await expect(dispatchPublicationJob(other.workspaceId, job.id)).rejects.toThrow("Active publication job not found");
    await expect(dispatchPublicationJob(workspaceId, "nope")).rejects.toThrow("Active publication job not found");

    responses.push(503);
    requests.length = 0;
    const failed = await dispatchPublicationJob(workspaceId, job.id);
    expect(failed).toMatchObject({ id: job.id, status: "retrying" });
    expect(JSON.stringify(failed)).not.toContain("config_json_encrypted");
    expect(requests[0].url).toBe(URL_OK);
    expect(requests[0].headers).toMatchObject({ Authorization: "Bearer t", "idempotency-key": job.idempotency_key, "x-polynovea-publication-job": job.id });

    responses.push(200);
    const ok = await dispatchPublicationJob(workspaceId, job.id);
    expect(ok).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(ok)).not.toContain("config_json_encrypted");
    const again = await dispatchPublicationJob(workspaceId, job.id);
    expect(again).toMatchObject({ status: "succeeded", attempt_count: 2 });
    expect(JSON.stringify(again)).not.toContain("config_json_encrypted");

    const [stored] = await listPublicationJobs(workspaceId);
    expect(stored).toMatchObject({ status: "succeeded", attempt_count: 2, last_error: null, next_attempt_at: null });
    const logs = await backend.query<{ attempt_number: number; status_code: number; outcome: string; detail: string | null }>("select attempt_number, status_code, outcome, detail from publication_delivery_logs where job_id = $1 order by attempt_number", [job.id]);
    expect(logs).toEqual([
      { attempt_number: 1, status_code: 503, outcome: "retrying", detail: "Destination returned 503" },
      { attempt_number: 2, status_code: 200, outcome: "succeeded", detail: null },
    ]);
  });
});
