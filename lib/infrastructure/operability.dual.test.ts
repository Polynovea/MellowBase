import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";

const { ensureEnvironmentComponents, listOperabilityOverview, runProvisioning, runSystemDoctor } = await import("@/lib/infrastructure/operabilityService");
const { createEnvironment } = await import("@/lib/infrastructure/environmentService");

const recorder = createRecorder();

async function rejection(promise: Promise<unknown>): Promise<{ message: string; status?: number }> {
  try {
    await promise;
  } catch (error) {
    return { message: (error as Error).message, status: (error as { status?: number }).status };
  }
  throw new Error("expected a rejection");
}

async function environment(backend: BackendFixtures, kind: "development" | "production", runtimeProvider: string | null) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const { environment } = await createEnvironment({ workspaceId, actorId: adminUserId, key: kind === "production" ? "prod" : "dev", name: kind, kind, runtimeProvider, secretProviderKind: "environment" });
  return { workspaceId, actorId: adminUserId, environmentId: environment.id as string };
}

describeBothBackends(["infrastructure"], "environment components, System Doctor and the operability overview", (backend) => {
  it("infers components, runs the doctor and lists the overview inside the workspace", async () => {
    const s = await environment(backend, "development", null);
    const components = await ensureEnvironmentComponents(s.workspaceId, s.environmentId);
    expect(components).toHaveLength(7);
    expect(Object.fromEntries(components.map((c) => [c.component_key, c.state]))).toEqual({
      postgres: "missing", "delivery-worker": "missing", "secret-store": "present", scheduler: "missing", "cms-http": "missing", "object-storage": "unsupported", "edge-runtime": "unsupported",
    });
    expect(components.slice(0, 5).every((c) => c.required)).toBe(true);
    // Re-evaluating updates the same rows instead of adding new ones.
    expect((await ensureEnvironmentComponents(s.workspaceId, s.environmentId)).map((c) => c.id).sort()).toEqual(components.map((c) => c.id).sort());

    const run = await runSystemDoctor(s);
    expect(run).toMatchObject({ workspace_id: s.workspaceId, environment_id: s.environmentId, status: "blocked", summary_json: { blocking: 4, warnings: 0, total: 5 } });
    const [env] = await backend.query<{ status: string; health_json: { lastRunId: string } }>("select status, health_json from workspace_environments where id = $1", [s.environmentId]);
    expect(env).toMatchObject({ status: "blocked", health_json: { lastRunId: run.id } });
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'infrastructure.doctor.ran'", [s.workspaceId])).toHaveLength(1);

    const overview = await listOperabilityOverview(s.workspaceId, s.environmentId);
    expect(overview.doctorRuns.map((r) => r.id)).toEqual([run.id]);
    expect(overview.components.map((c) => c.component_key)).toEqual(["cms-http", "delivery-worker", "edge-runtime", "object-storage", "postgres", "scheduler", "secret-store"]);
    expect((await listOperabilityOverview(s.workspaceId)).doctorRuns).toHaveLength(1);
    expect(await listOperabilityOverview(s.workspaceId, "nope")).toEqual({ doctorRuns: [], provisioningRuns: [], components: [], backups: [], upgrades: [], approvals: [], websites: [] });

    const other = await backend.createWorkspace();
    expect(await rejection(ensureEnvironmentComponents(other.workspaceId, s.environmentId))).toEqual({ message: "Environment not found", status: 404 });
    expect(await rejection(ensureEnvironmentComponents(s.workspaceId, "nope"))).toEqual({ message: "Environment not found", status: 404 });
    expect(await rejection(runSystemDoctor({ ...s, workspaceId: other.workspaceId }))).toEqual({ message: "Environment not found", status: 404 });
    expect((await listOperabilityOverview(other.workspaceId, s.environmentId)).doctorRuns).toEqual([]);
    recorder.record(backend.name, "doctor", { component: Object.keys(components[0]).sort(), run: Object.keys(run).sort(), overview: Object.keys(overview).sort() });
  });

  it("runs provisioning once per hour, gates production changes on approval and marks the approval executed", async () => {
    const dev = await environment(backend, "development", null);
    const blocked = await runProvisioning({ ...dev, providerKind: "local", operation: "verify" });
    expect(blocked).toMatchObject({ workspace_id: dev.workspaceId, status: "blocked", provider_kind: "local", operation: "verify" });
    expect((await runProvisioning({ ...dev, providerKind: "local", operation: "verify" })).id).toBe(blocked.id);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'infrastructure.provisioning.completed'", [dev.workspaceId])).toHaveLength(1);

    const prod = await environment(backend, "production", "local");
    expect(await rejection(runProvisioning({ ...prod, providerKind: "local", operation: "initialize" }))).toEqual({ message: "Production provisioning change requires approval.", status: 409 });
    const [request] = await backend.query<{ id: string }>("insert into infrastructure_approval_requests (workspace_id, environment_id, operation, entity_type, entity_id, request_json, requested_by, status, reviewed_by, reviewed_at) values ($1, $2, 'provision', 'workspace_environment', $4, '{}'::jsonb, $3, 'approved', $3, now()) returning id", [prod.workspaceId, prod.environmentId, prod.actorId, prod.environmentId]);
    const done = await runProvisioning({ ...prod, providerKind: "local", operation: "initialize" });
    expect(done).toMatchObject({ status: "succeeded" });
    const [approval] = await backend.query<{ status: string }>("select status from infrastructure_approval_requests where id = $1", [request.id]);
    expect(approval.status).toBe("executed");
    const [env] = await backend.query<{ status: string }>("select status from workspace_environments where id = $1", [prod.environmentId]);
    expect(env.status).toBe("provisioning");

    const other = await backend.createWorkspace();
    expect(await rejection(runProvisioning({ workspaceId: other.workspaceId, actorId: other.adminUserId, environmentId: dev.environmentId, providerKind: "local", operation: "verify" }))).toEqual({ message: "Environment not found", status: 404 });
    recorder.record(backend.name, "provisioning", { run: Object.keys(done).sort(), checks: done.checks_json.map((c: { key: string }) => c.key) });
  });
});

describe("operability backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
