import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { predictOperationalPlan, recordPlanPredictionOutcomes, trainSupportedOperationalModels, updateOperationalLearningPolicy } from "@/lib/intelligence/operationalMlService";
import { enforceOperationalLearningRetention, listOperationalMlFeedback, recordPredictionFeedback, refreshOnlineModelEvaluations } from "@/lib/intelligence/operationalMlGovernanceService";
import { compareOperationalPlanScenarios, listOperationalPlanComparisons, selectOperationalPlanScenario } from "@/lib/intelligence/predictivePlanningService";

const recorder = createRecorder();

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, 'staging', 'Staging', 'staging') returning id", [workspaceId]);
  const environmentId = environment.id;
  const base = Date.now() - 40 * 3_600_000;
  for (let i = 0; i < 30; i++) {
    await backend.query(
      "insert into operational_events (workspace_id, environment_id, event_type, source_type, occurred_at, features_json, outcome_json) values ($1, $2, 'plan.execution', 'operational_plan_execution', $3, $4::jsonb, $5::jsonb)",
      [workspaceId, environmentId, new Date(base + i * 3_600_000).toISOString(), JSON.stringify({ deterministicClassification: "safe" }), JSON.stringify({ status: i % 4 === 3 ? "failed" : "succeeded", durationMs: 1000 + i * 100 })],
    );
  }
  const [revision] = await backend.query<{ id: string }>("insert into operational_desired_state_revisions (workspace_id, environment_id, revision, desired_json, checksum_sha256) values ($1, $2, 1, '{}'::jsonb, $3) returning id", [workspaceId, environmentId, randomUUID()]);
  const [plan] = await backend.query<{ id: string }>(
    "insert into operational_change_plans (workspace_id, environment_id, desired_state_revision_id, name, deterministic_classification, immutable_plan_json, plan_checksum_sha256) values ($1, $2, $3, 'Plan', 'safe', '{}'::jsonb, $4) returning id",
    [workspaceId, environmentId, revision.id, randomUUID()],
  );
  await updateOperationalLearningPolicy({ workspaceId, actorId: adminUserId, localLearningEnabled: true, crossInstallLearningOptIn: false, retentionDays: 7 });
  await trainSupportedOperationalModels({ workspaceId, environmentId, actorId: adminUserId });
  return { workspaceId, adminUserId, environmentId, planId: plan.id };
}

describeBothBackends(["intelligence"], "ML governance and predictive plan comparison", (backend) => {
  it("evaluates predictions online, records feedback and applies retention inside the workspace", async () => {
    const s = await setup(backend);
    const { predictions } = await predictOperationalPlan({ workspaceId: s.workspaceId, environmentId: s.environmentId, planId: s.planId });
    await recordPlanPredictionOutcomes({ workspaceId: s.workspaceId, environmentId: s.environmentId, planId: s.planId, executionRunId: randomUUID(), status: "failed", durationMs: 1200 });
    const { evaluations } = await refreshOnlineModelEvaluations(s.workspaceId, s.environmentId);
    expect(evaluations.map((e) => `${e.evaluation_kind}:${e.sample_count}`)).toEqual(["online:1", "online:1"]);
    expect(evaluations.every((e) => e.workspace_id === s.workspaceId && e.status === "recorded")).toBe(true);

    const ready = predictions.find((p: { status: string }) => p.status === "ready");
    const feedback = await recordPredictionFeedback({ workspaceId: s.workspaceId, actorId: s.adminUserId, predictionId: ready.id, feedbackType: "corrected", correctedLabel: "adverse", reason: "r".repeat(2100), metadata: { source: "review" } });
    expect(feedback).toMatchObject({ prediction_id: ready.id, feedback_type: "corrected", metadata_json: { source: "review" } });
    expect(feedback.reason).toHaveLength(2000);
    const other = await setup(backend);
    await expect(recordPredictionFeedback({ workspaceId: other.workspaceId, actorId: other.adminUserId, predictionId: ready.id, feedbackType: "accepted" })).rejects.toThrow("Prediction not found");
    await expect(recordPredictionFeedback({ workspaceId: s.workspaceId, actorId: s.adminUserId, predictionId: "nope", feedbackType: "accepted" })).rejects.toThrow("Prediction not found");
    expect((await listOperationalMlFeedback(s.workspaceId, s.environmentId)).map((f) => f.id)).toEqual([feedback.id]);
    expect(await listOperationalMlFeedback(other.workspaceId, s.environmentId)).toEqual([]);

    // Retention (7 days): only rows older than the cutoff go, and only this workspace's.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    for (const ws of [s, other]) {
      await backend.query("insert into operational_events (workspace_id, environment_id, event_type, source_type, occurred_at) values ($1, $2, 'old', 'test', $3), ($1, $2, 'old', 'test', $3)", [ws.workspaceId, ws.environmentId, old]);
    }
    const retention = await enforceOperationalLearningRetention(s.workspaceId);
    expect(retention).toMatchObject({ retentionDays: 7, deleted: { featureSnapshots: 0, predictions: 0, operationalEvents: 2, evaluations: 0 } });
    expect(await backend.query("select 1 from operational_events where workspace_id = $1 and event_type = 'old'", [other.workspaceId])).toHaveLength(2);
    expect(await backend.query("select 1 from operational_events where workspace_id = $1 and event_type = 'plan.execution'", [s.workspaceId])).toHaveLength(30);
    recorder.record(backend.name, "governance", { evaluation: Object.keys(evaluations[0]).sort(), feedback: Object.keys(feedback).sort(), retention: retention.deleted });
  });

  it("compares plan scenarios, records the selected one and lists comparisons per workspace", async () => {
    const s = await setup(backend);
    const comparison = await compareOperationalPlanScenarios({ workspaceId: s.workspaceId, environmentId: s.environmentId, planId: s.planId, actorId: s.adminUserId });
    expect(comparison).toMatchObject({ workspace_id: s.workspaceId, plan_id: s.planId, selected_scenario_key: null });
    expect(comparison.comparison_json.scenarios.map((x: { key: string }) => x.key)).toEqual(["do_now", "do_later", "do_nothing"]);

    await expect(selectOperationalPlanScenario({ workspaceId: s.workspaceId, environmentId: s.environmentId, comparisonId: comparison.id, scenarioKey: "invent", actorId: s.adminUserId })).rejects.toThrow("Scenario is not part of this immutable comparison");
    const other = await setup(backend);
    await expect(selectOperationalPlanScenario({ workspaceId: other.workspaceId, environmentId: other.environmentId, comparisonId: comparison.id, scenarioKey: "do_now", actorId: other.adminUserId })).rejects.toThrow("Plan comparison not found");
    await expect(compareOperationalPlanScenarios({ workspaceId: other.workspaceId, environmentId: other.environmentId, planId: s.planId, actorId: other.adminUserId })).rejects.toThrow("Operational plan not found");
    const selected = await selectOperationalPlanScenario({ workspaceId: s.workspaceId, environmentId: s.environmentId, comparisonId: comparison.id, scenarioKey: "do_now", actorId: s.adminUserId, reason: "lowest risk" });
    expect(selected).toMatchObject({ id: comparison.id, selected_scenario_key: "do_now", selection_reason: "lowest risk", selected_by: s.adminUserId });

    expect((await listOperationalPlanComparisons(s.workspaceId, s.environmentId)).map((c) => c.id)).toEqual([comparison.id]);
    expect(await listOperationalPlanComparisons(other.workspaceId, s.environmentId)).toEqual([]);
    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and action like 'operational.plan.%' order by action", [s.workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["operational.plan.compared", "operational.plan.scenario_selected"]);
    recorder.record(backend.name, "comparison", { keys: Object.keys(selected).sort(), scenarios: comparison.comparison_json.scenarios.map((x: { key: string; predictions: unknown[] }) => `${x.key}:${x.predictions.length}`) });
  });
});

describe("ML governance backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
