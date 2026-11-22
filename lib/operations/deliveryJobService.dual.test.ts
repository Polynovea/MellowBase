import { describe, expect, it, vi } from "vitest";
import { describeBothBackends } from "@/lib/db/testing/dualBackend";
import { createRecorder, jsonRequest, LEAKED_DB_ERROR, readJson, routeParams } from "@/lib/db/testing/compare";
import {
  cancelDeliveryJob,
  enqueueDeliveryJob,
  getDeliveryJob,
  listDeliveryJobs,
  listDestinationHealth,
  replayDeliveryJob,
} from "@/lib/operations/deliveryJobService";
import { GET as listHandler } from "@/app/api/operations/jobs/route";
import { GET as getHandler } from "@/app/api/operations/jobs/[id]/route";
import { POST as cancelHandler } from "@/app/api/operations/jobs/[id]/cancel/route";
import { POST as replayHandler } from "@/app/api/operations/jobs/[id]/replay/route";
import { GET as healthHandler } from "@/app/api/operations/health/route";

const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const recorder = createRecorder();

describeBothBackends("operations", "delivery job service", (backend) => {
  it("enqueues idempotently, lists with filters, cancels and replays with identical shapes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const job = await enqueueDeliveryJob({ workspaceId, actorId: adminUserId, kind: "webhook", idempotencyKey: "k-1", payload: { a: [1, 2] }, safeMetadata: { note: "x" } }) as Record<string, any>;
    expect(job).toMatchObject({ workspace_id: workspaceId, kind: "webhook", status: "queued", payload_json: { a: [1, 2] } });
    const again = await enqueueDeliveryJob({ workspaceId, actorId: adminUserId, kind: "webhook", idempotencyKey: "k-1" }) as Record<string, any>;
    expect(again.id).toBe(job.id);
    await enqueueDeliveryJob({ workspaceId, actorId: adminUserId, kind: "search_index", idempotencyKey: "k-2", correlationId: job.correlation_id });

    expect((await listDeliveryJobs({ workspaceId })).length).toBe(2);
    expect((await listDeliveryJobs({ workspaceId, kind: "webhook" })).map((j) => j.id)).toEqual([job.id]);
    expect((await listDeliveryJobs({ workspaceId, correlationId: job.correlation_id })).length).toBe(2);
    expect(await listDeliveryJobs({ workspaceId, status: "succeeded" })).toEqual([]);
    expect((await listDeliveryJobs({ workspaceId, limit: 1 })).length).toBe(1);

    const cancelled = await cancelDeliveryJob({ workspaceId, actorId: adminUserId, jobId: job.id }) as Record<string, any>;
    expect(cancelled.status).toBe("cancelled");
    const replayed = await replayDeliveryJob({ workspaceId, actorId: adminUserId, jobId: job.id }) as Record<string, any>;
    expect(replayed).toBeTruthy();

    const detail = await getDeliveryJob(workspaceId, job.id);
    expect(detail?.job).toMatchObject({ id: job.id, status: "cancelled" });
    expect(Array.isArray(detail?.attempts)).toBe(true);
    expect(detail?.audit.map((event) => event.action)).toEqual(expect.arrayContaining([expect.stringContaining("cancel")]));
    expect(await getDeliveryJob(workspaceId, "not-a-uuid")).toBeNull();

    recorder.record(backend.name, "jobs", {
      job: { ...job, idempotency_key: job.idempotency_key, run_after: "<time>" },
      cancelled: { ...cancelled, run_after: "<time>" },
      keys: Object.keys(detail ?? {}).sort(),
      jobKeys: Object.keys(detail?.job ?? {}).sort(),
    });
  });

  it("reports the SQL functions' own messages and refuses to replay a live job", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const job = await enqueueDeliveryJob({ workspaceId, actorId: adminUserId, kind: "webhook", idempotencyKey: "live" }) as Record<string, any>;
    await expect(replayDeliveryJob({ workspaceId, actorId: adminUserId, jobId: job.id })).rejects.toThrow("Only terminal jobs can be replayed");
    await expect(cancelDeliveryJob({ workspaceId, actorId: adminUserId, jobId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow("Delivery job not found");
  });

  it("lists destination health for one workspace", async () => {
    const { workspaceId } = await backend.createWorkspace();
    await backend.query(
      "insert into delivery_destination_health (workspace_id, destination_kind, destination_id, health_state) values ($1, 'webhook_subscription', gen_random_uuid(), 'healthy')",
      [workspaceId],
    );
    const health = await listDestinationHealth(workspaceId);
    expect(health).toEqual([expect.objectContaining({ workspace_id: workspaceId, health_state: "healthy", consecutive_failures: 0 })]);
    recorder.record(backend.name, "health", health.map((row) => ({ ...row, destination_id: "<id>" })));
  });

  it("keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const job = await enqueueDeliveryJob({ workspaceId: a.workspaceId, actorId: a.adminUserId, kind: "webhook", idempotencyKey: "iso" }) as Record<string, any>;
    expect(await listDeliveryJobs({ workspaceId: b.workspaceId })).toEqual([]);
    expect(await getDeliveryJob(b.workspaceId, job.id)).toBeNull();
    await expect(cancelDeliveryJob({ workspaceId: b.workspaceId, actorId: b.adminUserId, jobId: job.id })).rejects.toThrow();
    expect((await getDeliveryJob(a.workspaceId, job.id))?.job.status).toBe("queued");
    expect(await listDestinationHealth(b.workspaceId)).toEqual([]);
  });

  it("serves the operations routes end to end without leaking database errors", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    actor.workspaceId = workspaceId;
    actor.adminUserId = adminUserId;
    const job = await enqueueDeliveryJob({ workspaceId, actorId: adminUserId, kind: "webhook", idempotencyKey: "route" }) as Record<string, any>;
    expect((await readJson(await listHandler(jsonRequest(undefined, "http://cms.test/api/operations/jobs?kind=webhook")))).body.data).toHaveLength(1);
    expect(await readJson(await getHandler(jsonRequest(), routeParams({ id: job.id })))).toMatchObject({ status: 200, body: { data: { job: { id: job.id } } } });
    expect(await readJson(await getHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })))).toMatchObject({ status: 404 });
    expect(await readJson(await cancelHandler(jsonRequest({}), routeParams({ id: job.id })))).toMatchObject({ body: { data: { status: "cancelled" } } });
    expect(await readJson(await replayHandler(jsonRequest({}), routeParams({ id: job.id })))).toMatchObject({ status: 201 });
    expect((await readJson(await healthHandler(jsonRequest(undefined, "http://cms.test/api/operations/health")))).status).toBe(200);
    for (const response of [
      await cancelHandler(jsonRequest({}), routeParams({ id: "not-a-uuid" })),
      await listHandler(jsonRequest(undefined, "http://cms.test/api/operations/jobs?correlationId=nope")),
    ]) {
      const { status, body } = await readJson(response);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error).not.toMatch(LEAKED_DB_ERROR);
    }
  });
});

describe("operations backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
