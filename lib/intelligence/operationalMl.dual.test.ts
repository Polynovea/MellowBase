import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import {
  captureOperationalFeatureSnapshot, ensureOperationalModelRegistry, getOperationalLearningPolicy, listOperationalMlOverview, predictOperationalPlan,
  predictRemediationSuccess, recordPlanPredictionOutcomes, trainSupportedOperationalModels, updateOperationalLearningPolicy,
} from "@/lib/intelligence/operationalMlService";

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const [environment] = await backend.query<{ id: string }>("insert into workspace_environments (workspace_id, key, name, kind) values ($1, 'staging', 'Staging', 'staging') returning id", [workspaceId]);
  const environmentId = environment.id;
  // 30 plan executions (every fourth adverse) and 18 remediation outcomes, an hour apart: enough for the
  // 70% training split to meet the risk (20) and remediation (12) models' minimum support.
  const base = Date.now() - 60 * 3_600_000;
  for (let i = 0; i < 30; i++) {
    await backend.query(
      "insert into operational_events (workspace_id, environment_id, event_type, source_type, occurred_at, features_json, outcome_json) values ($1, $2, 'plan.execution', 'operational_plan_execution', $3, $4::jsonb, $5::jsonb)",
      [workspaceId, environmentId, new Date(base + i * 3_600_000).toISOString(), JSON.stringify({ deterministicClassification: "safe" }), JSON.stringify({ status: i % 4 === 3 ? "failed" : "succeeded", durationMs: 1000 + i * 100 })],
    );
  }
  for (let i = 0; i < 18; i++) {
    await backend.query(
      "insert into operational_events (workspace_id, environment_id, event_type, source_type, occurred_at, features_json, outcome_json) values ($1, $2, 'remediation.outcome', 'operational_remediation_run', $3, $4::jsonb, $5::jsonb)",
      [workspaceId, environmentId, new Date(base + (30 + i) * 3_600_000).toISOString(), JSON.stringify({ remediationKey: "world.rediscover" }), JSON.stringify({ status: i % 3 === 2 ? "failed" : "succeeded" })],
    );
  }
  const [revision] = await backend.query<{ id: string }>("insert into operational_desired_state_revisions (workspace_id, environment_id, revision, desired_json, checksum_sha256) values ($1, $2, 1, '{}'::jsonb, $3) returning id", [workspaceId, environmentId, randomUUID()]);
  const [plan] = await backend.query<{ id: string }>(
    "insert into operational_change_plans (workspace_id, environment_id, desired_state_revision_id, name, deterministic_classification, immutable_plan_json, plan_checksum_sha256) values ($1, $2, $3, 'Plan', 'safe', '{}'::jsonb, $4) returning id",
    [workspaceId, environmentId, revision.id, randomUUID()],
  );
  return { workspaceId, adminUserId, environmentId, planId: plan.id };
}

describeWithDatabase("operational ML", (backend) => {
  it("keeps one learning policy and one registry per workspace", async () => {
    const s = await setup(backend);
    const policy = await getOperationalLearningPolicy(s.workspaceId);
    expect((await getOperationalLearningPolicy(s.workspaceId)).id).toBe(policy.id);
    await expect(updateOperationalLearningPolicy({ workspaceId: s.workspaceId, actorId: s.adminUserId, localLearningEnabled: true, crossInstallLearningOptIn: false, retentionDays: 3 })).rejects.toThrow("Retention days must be between 7 and 3650");
    const updated = await updateOperationalLearningPolicy({ workspaceId: s.workspaceId, actorId: s.adminUserId, localLearningEnabled: true, crossInstallLearningOptIn: false, retentionDays: 30 });
    expect(updated).toMatchObject({ id: policy.id, local_learning_enabled: true, retention_days: 30, updated_by: s.adminUserId });
    const registry = await ensureOperationalModelRegistry(s.workspaceId);
    expect(registry).toHaveLength(10);
    expect((await ensureOperationalModelRegistry(s.workspaceId)).map((m) => m.id)).toEqual(registry.map((m) => m.id));
    const other = await backend.createWorkspace();
    expect((await getOperationalLearningPolicy(other.workspaceId)).id).not.toBe(policy.id);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'operational.ml.policy.updated'", [s.workspaceId])).toHaveLength(1);
  });

  it("trains, deploys, predicts and records outcomes from the workspace's own events", async () => {
    const s = await setup(backend);
    await updateOperationalLearningPolicy({ workspaceId: s.workspaceId, actorId: s.adminUserId, localLearningEnabled: true, crossInstallLearningOptIn: false, retentionDays: 30 });

    const snapshot = await captureOperationalFeatureSnapshot({ workspaceId: s.workspaceId, environmentId: s.environmentId });
    expect(snapshot).toMatchObject({ sample_support: 48, features_json: { environmentKind: "staging", eventCount: 48, planExecutions: 30, planAdverse: 7, remediationRuns: 18 } });
    expect(snapshot.source_event_ids).toHaveLength(48);

    const first = await trainSupportedOperationalModels({ workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId });
    expect(first.trained.map((t: { modelKey: string; version: number; status: string }) => `${t.modelKey}:${t.version}:${t.status}`).sort()).toEqual(["execution-duration:1:deployed", "migration-change-risk:1:deployed", "remediation-success:1:deployed"]);
    const second = await trainSupportedOperationalModels({ workspaceId: s.workspaceId, environmentId: s.environmentId, actorId: s.adminUserId });
    expect(second.trained.every((t: { version: number }) => t.version === 2)).toBe(true);
    const versions = await backend.query<{ version: number; status: string }>("select v.version, v.status from operational_model_versions v join operational_model_registry m on m.id = v.model_id where m.workspace_id = $1 and m.model_key = 'execution-duration' order by v.version", [s.workspaceId]);
    expect(versions).toEqual([{ version: 1, status: "retired" }, { version: 2, status: "deployed" }]);
    expect(await backend.query("select 1 from operational_model_evaluations where workspace_id = $1", [s.workspaceId])).toHaveLength(18);

    const remediation = await predictRemediationSuccess({ workspaceId: s.workspaceId, environmentId: s.environmentId, remediationKey: "world.rediscover" });
    expect(remediation).toMatchObject({ status: "ready", subject_type: "remediation_candidate", distribution_state: "in_distribution" });
    const plan = await predictOperationalPlan({ workspaceId: s.workspaceId, environmentId: s.environmentId, planId: s.planId, actorId: s.adminUserId });
    expect(plan.predictions.map((p: { prediction_key: string; status: string }) => `${p.prediction_key.split(":")[0]}:${p.status}`).sort()).toEqual(["dependency_impact:insufficient_data", "execution_duration:ready", "migration_change_risk:ready"]);
    expect(await recordPlanPredictionOutcomes({ workspaceId: s.workspaceId, environmentId: s.environmentId, planId: s.planId, executionRunId: randomUUID(), status: "succeeded", durationMs: 1500 })).toEqual({ evaluatedPredictions: 2 });
    expect(await recordPlanPredictionOutcomes({ workspaceId: s.workspaceId, environmentId: s.environmentId, planId: s.planId, executionRunId: randomUUID(), status: "failed", durationMs: 900 })).toEqual({ evaluatedPredictions: 2 });
    expect(await backend.query("select 1 from operational_prediction_outcomes where workspace_id = $1", [s.workspaceId])).toHaveLength(2);

    // A tampered artifact fails its integrity check and the version is withdrawn.
    await backend.query("update operational_model_versions set artifact_json = '{\"tampered\": true}'::jsonb where workspace_id = $1 and status = 'deployed' and model_id = (select id from operational_model_registry where workspace_id = $1 and model_key = 'remediation-success')", [s.workspaceId]);
    expect(await predictRemediationSuccess({ workspaceId: s.workspaceId, environmentId: s.environmentId, remediationKey: "world.rediscover" })).toMatchObject({ status: "insufficient_data" });
    expect(await backend.query("select 1 from operational_model_versions where workspace_id = $1 and status = 'failed'", [s.workspaceId])).toHaveLength(1);

    const overview = await listOperationalMlOverview(s.workspaceId, s.environmentId);
    expect(overview.predictions.length).toBe(5);
    expect(overview.featureSnapshots.length).toBe(4);
    const other = await setup(backend);
    await expect(predictOperationalPlan({ workspaceId: other.workspaceId, environmentId: other.environmentId, planId: s.planId })).rejects.toThrow("Operational plan not found");
    expect((await listOperationalMlOverview(other.workspaceId, s.environmentId)).predictions).toEqual([]);
  });
});
