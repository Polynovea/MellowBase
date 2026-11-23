import * as mlData from "@/lib/intelligence/mlData";
import { sha256Canonical } from "@/lib/intelligence/operationalCanonical";
import { logPlatformEvent } from "@/lib/platform/audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODEL_DEFINITIONS = [
  { key: "migration-change-risk", family: "migration_change_risk", task: "probability", title: "Migration / Change Risk", minimumSupport: 20, description: "Calibrated local probability of an adverse execution outcome, conditioned on deterministic classification." },
  { key: "execution-duration", family: "execution_duration", task: "duration", title: "Execution Duration", minimumSupport: 12, description: "Local empirical duration interval for governed plan execution." },
  { key: "failure-root-cause", family: "failure_root_cause", task: "classification", title: "Failure Root-cause", minimumSupport: 40, description: "Ranks likely fault domains from privacy-safe operational evidence." },
  { key: "subsystem-anomaly", family: "subsystem_anomaly", task: "anomaly", title: "Subsystem Anomaly", minimumSupport: 60, description: "Learns normal operational envelopes for measurable CMS subsystems." },
  { key: "capacity-forecast", family: "capacity_forecast", task: "forecast", title: "Capacity Forecast", minimumSupport: 60, description: "Forecasts operational capacity and exhaustion windows from measured history." },
  { key: "plan-ranking", family: "plan_ranking", task: "ranking", title: "Plan Ranking", minimumSupport: 40, description: "Ranks deterministically valid alternative plans by predicted operational outcomes." },
  { key: "dependency-impact", family: "dependency_impact", task: "probability", title: "Dependency Impact", minimumSupport: 50, description: "Estimates likely downstream impact regions while preserving deterministic topology." },
  { key: "remediation-success", family: "remediation_success", task: "probability", title: "Remediation Success", minimumSupport: 12, description: "Calibrated local probability that a registered deterministic remediation converges." },
  { key: "maintenance-window", family: "maintenance_window", task: "forecast", title: "Maintenance Window", minimumSupport: 60, description: "Recommends lower-risk execution windows from observed operational workload." },
  { key: "environment-health-forecast", family: "environment_health_forecast", task: "probability", title: "Environment Health Forecast", minimumSupport: 80, description: "Estimates probability of future degradation before deterministic thresholds are crossed." },
] as const;

type ModelFamily = typeof MODEL_DEFINITIONS[number]["family"];

type OperationalEvent = {
  id: string;
  event_type: string;
  occurred_at: string;
  features_json: Record<string, any>;
  outcome_json: Record<string, any>;
};

function quantile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

function chronologicalSplit<T>(rows: T[]) {
  const n = rows.length;
  const trainEnd = Math.max(1, Math.floor(n * 0.7));
  const validationEnd = Math.max(trainEnd, Math.floor(n * 0.85));
  return { train: rows.slice(0, trainEnd), validation: rows.slice(trainEnd, validationEnd), holdout: rows.slice(validationEnd) };
}

function betaBernoulli(successes: number, failures: number) {
  const alpha = successes + 1;
  const beta = failures + 1;
  const total = alpha + beta;
  const mean = alpha / total;
  const variance = (alpha * beta) / (total * total * (total + 1));
  const sd = Math.sqrt(variance);
  return { mean, lower: Math.max(0, mean - 1.96 * sd), upper: Math.min(1, mean + 1.96 * sd), alpha, beta, support: successes + failures };
}

function brierScore(rows: Array<{ outcome: number; probability: number }>) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / rows.length;
}

function meanAbsoluteError(rows: Array<{ actual: number; predicted: number }>) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + Math.abs(row.actual - row.predicted), 0) / rows.length;
}

export async function getOperationalLearningPolicy(workspaceId: string) {
  return mlData.learningPolicy(workspaceId);
}

export async function updateOperationalLearningPolicy(params: {
  workspaceId: string;
  actorId: string;
  localLearningEnabled: boolean;
  crossInstallLearningOptIn: boolean;
  contentLevelFeaturesEnabled?: boolean;
  retentionDays?: number;
}) {
  const retentionDays = params.retentionDays ?? 365;
  if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) throw Object.assign(new Error("Retention days must be between 7 and 3650"), { status: 400 });
  return mlData.saveLearningPolicy({
    workspace_id: params.workspaceId,
    local_learning_enabled: params.localLearningEnabled,
    cross_install_learning_opt_in: params.crossInstallLearningOptIn,
    content_level_features_enabled: Boolean(params.contentLevelFeaturesEnabled),
    retention_days: retentionDays,
    updated_by: params.actorId,
    updated_at: new Date().toISOString(),
  }, (data) => ({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "operational.ml.policy.updated", entityType: "workspace", entityId: params.workspaceId, metadata: { localLearningEnabled: data.local_learning_enabled, crossInstallLearningOptIn: data.cross_install_learning_opt_in, contentLevelFeaturesEnabled: data.content_level_features_enabled, retentionDays: data.retention_days } }));
}

export async function ensureOperationalModelRegistry(workspaceId: string) {
  return mlData.ensureRegistry(workspaceId, MODEL_DEFINITIONS.map((definition) => ({
      workspace_id: workspaceId,
      model_key: definition.key,
      model_family: definition.family,
      task_type: definition.task,
      scope: "workspace_local",
      title: definition.title,
      description: definition.description,
      owner: "cms-operational-intelligence",
      enabled: true,
      minimum_support: definition.minimumSupport,
      feature_contract_json: { version: 1, privacy: "operational_minimized", contentValues: false, credentialValues: false },
      updated_at: new Date().toISOString(),
  })));
}

async function localEvents(workspaceId: string, environmentId: string, retentionDays: number): Promise<OperationalEvent[]> {
  const start = new Date(Date.now() - retentionDays * 86400000).toISOString();
  return (await mlData.localEvents(workspaceId, environmentId, start)) as OperationalEvent[];
}

export async function captureOperationalFeatureSnapshot(params: { workspaceId: string; environmentId: string; featureFamily?: string }) {
  const policy = await getOperationalLearningPolicy(params.workspaceId);
  const events = await localEvents(params.workspaceId, params.environmentId, policy.retention_days);
  const { environment, worldNodes, drifts } = await mlData.snapshotInputs(params.workspaceId, params.environmentId);
  if (!environment) throw Object.assign(new Error("Environment not found"), { status: 404 });

  const planEvents = events.filter((event) => event.event_type === "plan.execution");
  const remediationEvents = events.filter((event) => event.event_type === "remediation.outcome");
  const schemaAssessments = events.filter((event) => event.event_type === "schema_change.assessment");
  const durations = planEvents.map((event) => Number(event.outcome_json?.durationMs)).filter((value) => Number.isFinite(value) && value >= 0);
  const features = {
    environmentKind: environment.kind,
    deterministicEnvironmentStatus: environment.status,
    observationWindowDays: policy.retention_days,
    eventCount: events.length,
    planExecutions: planEvents.length,
    planSucceeded: planEvents.filter((event) => event.outcome_json?.status === "succeeded").length,
    planAdverse: planEvents.filter((event) => event.outcome_json?.status !== "succeeded").length,
    planDurationMedianMs: quantile(durations, 0.5),
    planDurationP90Ms: quantile(durations, 0.9),
    remediationRuns: remediationEvents.length,
    remediationSucceeded: remediationEvents.filter((event) => event.outcome_json?.status === "succeeded").length,
    schemaAssessments: schemaAssessments.length,
    schemaAssessmentsBlocked: schemaAssessments.filter((event) => event.outcome_json?.directApplyBlocked === true).length,
    worldNodeCount: (worldNodes ?? []).length,
    staleWorldNodeCount: (worldNodes ?? []).filter((node) => node.is_stale).length,
    degradedWorldNodeCount: (worldNodes ?? []).filter((node) => ["degraded", "blocked", "missing", "outdated"].includes(node.state)).length,
    openDriftCount: (drifts ?? []).length,
    blockingDriftCount: (drifts ?? []).filter((drift) => drift.severity === "blocking").length,
    approvalRequiredDriftCount: (drifts ?? []).filter((drift) => drift.action_class === "approval_required").length,
  };
  const capturedAt = new Date().toISOString();
  const document = {
    featureFamily: params.featureFamily ?? "environment_operational_v1",
    contractVersion: 1,
    environmentId: params.environmentId,
    features,
    sourceEventIds: events.map((event) => event.id),
    sourceWindowStart: events[0]?.occurred_at ?? null,
    sourceWindowEnd: events.at(-1)?.occurred_at ?? null,
    capturedAt,
  };
  const checksum = sha256Canonical(document);
  return mlData.insertSnapshot({
    workspace_id: params.workspaceId,
    environment_id: params.environmentId,
    feature_family: document.featureFamily,
    feature_contract_version: 1,
    features_json: features,
    provenance_json: { source: "operational_events+deterministic_world", rawContentIncluded: false, credentialValuesIncluded: false, eventTypes: [...new Set(events.map((event) => event.event_type))] },
    source_event_ids: document.sourceEventIds,
    source_window_start: document.sourceWindowStart,
    source_window_end: document.sourceWindowEnd,
    sample_support: events.length,
    checksum_sha256: checksum,
    captured_at: capturedAt,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
}

async function persistModelVersion(params: { workspaceId: string; actorId: string; model: any; technique: string; train: OperationalEvent[]; validation: OperationalEvent[]; holdout: OperationalEvent[]; artifact: Record<string, unknown>; metrics: Record<string, unknown>; calibration: Record<string, unknown> }) {
  const valid = params.validation.length > 0 && params.holdout.length > 0 && params.train.length >= Number(params.model.minimum_support);
  return mlData.persistModelVersion(params.workspaceId, params.model.id, (version) => ({
    workspace_id: params.workspaceId,
    model_id: params.model.id,
    version,
    status: "candidate",
    technique: params.technique,
    training_window_start: params.train[0]?.occurred_at ?? null,
    training_window_end: params.train.at(-1)?.occurred_at ?? null,
    training_sample_count: params.train.length,
    validation_sample_count: params.validation.length,
    holdout_sample_count: params.holdout.length,
    feature_contract_json: params.model.feature_contract_json,
    artifact_json: params.artifact,
    metrics_json: params.metrics,
    calibration_json: params.calibration,
    integrity_sha256: sha256Canonical({ modelKey: params.model.model_key, version, technique: params.technique, artifact: params.artifact, featureContract: params.model.feature_contract_json }),
    created_by: params.actorId,
  }), valid, (versionId) => [
    { workspace_id: params.workspaceId, model_version_id: versionId, evaluation_kind: "validation", sample_count: params.validation.length, metrics_json: params.metrics.validation ?? {}, distribution_json: { chronologicalHoldout: true }, status: "recorded" },
    { workspace_id: params.workspaceId, model_version_id: versionId, evaluation_kind: "holdout", sample_count: params.holdout.length, metrics_json: params.metrics.holdout ?? {}, distribution_json: { chronologicalHoldout: true }, status: "recorded" },
    { workspace_id: params.workspaceId, model_version_id: versionId, evaluation_kind: "calibration", sample_count: params.validation.length + params.holdout.length, metrics_json: params.calibration, distribution_json: {}, status: params.calibration.state === "calibrated" ? "recorded" : "warning" },
  ]);
}

function riskArtifact(events: OperationalEvent[]) {
  const byClassification: Record<string, { success: number; adverse: number }> = {};
  let success = 0, adverse = 0;
  for (const event of events) {
    const classification = String(event.features_json?.deterministicClassification ?? "unknown");
    const ok = event.outcome_json?.status === "succeeded";
    byClassification[classification] ??= { success: 0, adverse: 0 };
    if (ok) { success++; byClassification[classification].success++; } else { adverse++; byClassification[classification].adverse++; }
  }
  return { overall: { success, adverse, posterior: betaBernoulli(adverse, success) }, byClassification: Object.fromEntries(Object.entries(byClassification).map(([key, value]) => [key, { ...value, posterior: betaBernoulli(value.adverse, value.success) }])) };
}

function riskMetrics(artifact: any, events: OperationalEvent[]) {
  const rows = events.map((event) => {
    const classification = String(event.features_json?.deterministicClassification ?? "unknown");
    const group = artifact.byClassification[classification]?.posterior ?? artifact.overall.posterior;
    return { outcome: event.outcome_json?.status === "succeeded" ? 0 : 1, probability: Number(group.mean) };
  });
  return { brierScore: brierScore(rows), sampleCount: rows.length };
}

function remediationArtifact(events: OperationalEvent[]) {
  const byKey: Record<string, { success: number; failure: number }> = {};
  for (const event of events) {
    const key = String(event.features_json?.remediationKey ?? "unknown");
    byKey[key] ??= { success: 0, failure: 0 };
    if (event.outcome_json?.status === "succeeded") byKey[key].success++; else byKey[key].failure++;
  }
  return { byKey: Object.fromEntries(Object.entries(byKey).map(([key, value]) => [key, { ...value, posterior: betaBernoulli(value.success, value.failure) }])) };
}

function remediationMetrics(artifact: any, events: OperationalEvent[]) {
  const rows = events.filter((event) => artifact.byKey[String(event.features_json?.remediationKey ?? "unknown")]).map((event) => ({ outcome: event.outcome_json?.status === "succeeded" ? 1 : 0, probability: Number(artifact.byKey[String(event.features_json?.remediationKey)].posterior.mean) }));
  return { brierScore: brierScore(rows), sampleCount: rows.length };
}

function impactArtifact(events: OperationalEvent[]) {
  const byClassification: Record<string, { impacted: number; clear: number; counts: number[] }> = {};
  let impacted = 0, clear = 0;
  const counts: number[] = [];
  for (const event of events) {
    const classification = String(event.features_json?.deterministicClassification ?? "unknown");
    const count = Math.max(0, Number(event.outcome_json?.downstreamImpactCount ?? event.outcome_json?.remainingDriftCount ?? 0) || 0);
    counts.push(count);
    byClassification[classification] ??= { impacted: 0, clear: 0, counts: [] };
    byClassification[classification].counts.push(count);
    if (count > 0) { impacted++; byClassification[classification].impacted++; } else { clear++; byClassification[classification].clear++; }
  }
  const stats = (row: { impacted: number; clear: number; counts: number[] }) => ({ impacted: row.impacted, clear: row.clear, support: row.impacted + row.clear, posterior: betaBernoulli(row.impacted, row.clear), impactCountMedian: quantile(row.counts, 0.5), impactCountP90: quantile(row.counts, 0.9) });
  return { overall: stats({ impacted, clear, counts }), byClassification: Object.fromEntries(Object.entries(byClassification).map(([key, row]) => [key, stats(row)])) };
}

function impactMetrics(artifact: any, events: OperationalEvent[]) {
  const rows = events.map((event) => {
    const classification = String(event.features_json?.deterministicClassification ?? "unknown");
    const group = artifact.byClassification[classification]?.posterior ?? artifact.overall.posterior;
    const count = Math.max(0, Number(event.outcome_json?.downstreamImpactCount ?? event.outcome_json?.remainingDriftCount ?? 0) || 0);
    return { outcome: count > 0 ? 1 : 0, probability: Number(group.mean) };
  });
  return { brierScore: brierScore(rows), sampleCount: rows.length };
}

function durationArtifact(events: OperationalEvent[]) {
  const values = events.map((event) => Number(event.outcome_json?.durationMs)).filter((value) => Number.isFinite(value) && value >= 0);
  const groups: Record<string, number[]> = {};
  for (const event of events) {
    const duration = Number(event.outcome_json?.durationMs);
    if (!Number.isFinite(duration) || duration < 0) continue;
    const classification = String(event.features_json?.deterministicClassification ?? "unknown");
    (groups[classification] ??= []).push(duration);
  }
  const stats = (rows: number[]) => ({ support: rows.length, p10: quantile(rows, 0.1), median: quantile(rows, 0.5), p90: quantile(rows, 0.9) });
  return { overall: stats(values), byClassification: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, stats(rows)])) };
}

function durationMetrics(artifact: any, events: OperationalEvent[]) {
  const rows = events.flatMap((event) => {
    const actual = Number(event.outcome_json?.durationMs);
    if (!Number.isFinite(actual) || actual < 0) return [];
    const classification = String(event.features_json?.deterministicClassification ?? "unknown");
    const predicted = Number(artifact.byClassification[classification]?.median ?? artifact.overall.median);
    return Number.isFinite(predicted) ? [{ actual, predicted }] : [];
  });
  return { meanAbsoluteErrorMs: meanAbsoluteError(rows), sampleCount: rows.length };
}

export async function trainSupportedOperationalModels(params: { workspaceId: string; environmentId: string; actorId: string }) {
  const policy = await getOperationalLearningPolicy(params.workspaceId);
  const models = await ensureOperationalModelRegistry(params.workspaceId);
  if (!policy.local_learning_enabled) return { status: "disabled", reason: "local_learning_disabled", trained: [], insufficient: models.map((model: any) => model.model_key) };
  const events = await localEvents(params.workspaceId, params.environmentId, policy.retention_days);
  const trained: any[] = [];
  const insufficient: Array<Record<string, unknown>> = [];

  for (const model of models) {
    let relevant: OperationalEvent[] = [];
    let technique = "not_implemented";
    let artifact: Record<string, any> | null = null;
    let metricFn: ((artifact: any, events: OperationalEvent[]) => Record<string, unknown>) | null = null;
    if (model.model_family === "migration_change_risk") {
      relevant = events.filter((event) => event.event_type === "plan.execution"); technique = "beta_bernoulli_empirical_bayes"; metricFn = riskMetrics;
    } else if (model.model_family === "execution_duration") {
      relevant = events.filter((event) => event.event_type === "plan.execution" && Number.isFinite(Number(event.outcome_json?.durationMs))); technique = "empirical_quantile_interval"; metricFn = durationMetrics;
    } else if (model.model_family === "remediation_success") {
      relevant = events.filter((event) => event.event_type === "remediation.outcome"); technique = "beta_bernoulli_empirical_bayes"; metricFn = remediationMetrics;
    } else if (model.model_family === "dependency_impact") {
      relevant = events.filter((event) => event.event_type === "plan.execution" && (event.outcome_json?.downstreamImpactCount !== undefined || event.outcome_json?.remainingDriftCount !== undefined)); technique = "beta_bernoulli_empirical_bayes_with_empirical_impact_count"; metricFn = impactMetrics;
    } else {
      insufficient.push({ modelKey: model.model_key, family: model.model_family, status: "insufficient_data", support: 0, minimumSupport: model.minimum_support, reason: "specialist_trainer_requires_additional_signal_history" });
      continue;
    }
    if (relevant.length < Number(model.minimum_support)) {
      insufficient.push({ modelKey: model.model_key, family: model.model_family, status: "insufficient_data", support: relevant.length, minimumSupport: model.minimum_support, reason: "minimum_support_not_met" });
      continue;
    }
    const split = chronologicalSplit(relevant);
    artifact = model.model_family === "migration_change_risk" ? riskArtifact(split.train) : model.model_family === "execution_duration" ? durationArtifact(split.train) : model.model_family === "dependency_impact" ? impactArtifact(split.train) : remediationArtifact(split.train);
    const validationMetrics = metricFn!(artifact, split.validation);
    const holdoutMetrics = metricFn!(artifact, split.holdout);
    const calibrationState = split.validation.length >= 3 && split.holdout.length >= 3 ? "calibrated" : "provisional";
    const version = await persistModelVersion({
      workspaceId: params.workspaceId,
      actorId: params.actorId,
      model,
      technique,
      train: split.train,
      validation: split.validation,
      holdout: split.holdout,
      artifact,
      metrics: { validation: validationMetrics, holdout: holdoutMetrics },
      calibration: { state: calibrationState, method: model.task_type === "probability" ? "beta_posterior_with_chronological_holdout" : "empirical_interval_with_chronological_holdout", leakageControl: "chronological train/validation/holdout; event IDs are unique" },
    });
    trained.push({ modelKey: model.model_key, family: model.model_family, modelVersionId: version.id, version: version.version, status: version.status, support: relevant.length, technique });
  }
  await logPlatformEvent({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "operational.ml.training.completed", entityType: "workspace_environment", entityId: params.environmentId, metadata: { trained: trained.map((item) => ({ modelKey: item.modelKey, version: item.version, status: item.status, support: item.support })), insufficientCount: insufficient.length } });
  return { status: trained.some((item) => item.status === "deployed") ? "models_available" : "insufficient_data", trained, insufficient };
}

async function deployedModel(workspaceId: string, family: ModelFamily) {
  const { model, version } = await mlData.deployedModelRows(workspaceId, family);
  if (!model) return { model: null, version: null, integrity: "unavailable" as const };
  if (!version) return { model, version: null, integrity: "unavailable" as const };
  const expected = sha256Canonical({ modelKey: model.model_key, version: version.version, technique: version.technique, artifact: version.artifact_json, featureContract: version.feature_contract_json });
  if (expected !== version.integrity_sha256) {
    await mlData.failDeployedVersion(workspaceId, version.id);
    return { model, version: null, integrity: "failed" as const };
  }
  return { model, version, integrity: "verified" as const };
}

async function persistPrediction(params: { workspaceId: string; environmentId: string; model: any; version?: any; snapshot?: any; predictionKey: string; subjectType: string; subjectId?: string | null; status: string; predictedLabel?: string | null; probability?: number | null; estimate?: number | null; lower?: number | null; upper?: number | null; confidence?: number | null; supportCount?: number; calibrationState?: string; distributionState?: string; prediction?: Record<string, unknown>; explanation?: Record<string, unknown> }) {
  return mlData.insertPrediction({
    workspace_id: params.workspaceId,
    environment_id: params.environmentId,
    model_id: params.model.id,
    model_version_id: params.version?.id ?? null,
    feature_snapshot_id: params.snapshot?.id ?? null,
    prediction_key: params.predictionKey,
    subject_type: params.subjectType,
    subject_id: params.subjectId ?? null,
    status: params.status,
    predicted_label: params.predictedLabel ?? null,
    probability: params.probability ?? null,
    estimate: params.estimate ?? null,
    interval_lower: params.lower ?? null,
    interval_upper: params.upper ?? null,
    confidence: params.confidence ?? null,
    support_count: params.supportCount ?? 0,
    calibration_state: params.calibrationState ?? "unavailable",
    distribution_state: params.distributionState ?? "unknown",
    prediction_json: params.prediction ?? {},
    explanation_json: params.explanation ?? {},
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
}

export async function predictOperationalPlan(params: { workspaceId: string; environmentId: string; planId: string; actorId?: string | null }) {
  await ensureOperationalModelRegistry(params.workspaceId);
  const policy = await getOperationalLearningPolicy(params.workspaceId);
  const plan = UUID.test(params.environmentId) && UUID.test(params.planId) ? await mlData.planForPrediction(params.workspaceId, params.environmentId, params.planId) : null;
  if (!plan) throw Object.assign(new Error("Operational plan not found"), { status: 404 });
  const snapshot = await captureOperationalFeatureSnapshot({ workspaceId: params.workspaceId, environmentId: params.environmentId, featureFamily: "plan_prediction_v1" });
  const results: any[] = [];

  for (const family of ["migration_change_risk", "execution_duration", "dependency_impact"] as const) {
    const { model, version } = await deployedModel(params.workspaceId, family);
    if (!model) continue;
    if (!policy.local_learning_enabled || !version) {
      results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: policy.local_learning_enabled ? "insufficient_data" : "disabled", supportCount: 0, distributionState: "low_support", explanation: { reason: policy.local_learning_enabled ? "no_validated_deployed_model" : "local_learning_disabled", deterministicClassification: plan.deterministic_classification, safetyAuthority: "deterministic_controller" } }));
      continue;
    }
    const artifact = version.artifact_json ?? {};
    const classification = String(plan.deterministic_classification);
    if (family === "migration_change_risk") {
      const group = artifact.byClassification?.[classification]?.posterior ?? null;
      if (!group || Number(group.support ?? 0) < Math.max(5, Math.floor(Number(model.minimum_support) / 4))) {
        results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: "out_of_distribution", supportCount: Number(group?.support ?? 0), calibrationState: version.calibration_json?.state ?? "unavailable", distributionState: "out_of_distribution", explanation: { reason: "insufficient_support_for_deterministic_classification", deterministicClassification: classification, safetyAuthority: "deterministic_controller" } }));
      } else {
        const probability = Number(group.mean);
        results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: "ready", predictedLabel: probability >= 0.5 ? "elevated_adverse_outcome_risk" : "lower_observed_adverse_outcome_risk", probability, lower: Number(group.lower), upper: Number(group.upper), confidence: Math.min(1, Number(group.support) / Math.max(Number(model.minimum_support), 1)), supportCount: Number(group.support), calibrationState: version.calibration_json?.state ?? "provisional", distributionState: "in_distribution", prediction: { adverseOutcomeProbability: probability, interval: [Number(group.lower), Number(group.upper)] }, explanation: { technique: version.technique, deterministicClassification: classification, support: group.support, deterministicClassificationCannotBeDowngraded: true, safetyAuthority: "deterministic_controller" } }));
      }
    } else if (family === "execution_duration") {
      const group = artifact.byClassification?.[classification] ?? null;
      if (!group || Number(group.support ?? 0) < Math.max(4, Math.floor(Number(model.minimum_support) / 4))) {
        results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: "out_of_distribution", supportCount: Number(group?.support ?? 0), calibrationState: version.calibration_json?.state ?? "unavailable", distributionState: "out_of_distribution", explanation: { reason: "insufficient_duration_support_for_classification", deterministicClassification: classification, safetyAuthority: "deterministic_controller" } }));
      } else {
        results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: "ready", estimate: Number(group.median), lower: Number(group.p10), upper: Number(group.p90), confidence: Math.min(1, Number(group.support) / Math.max(Number(model.minimum_support), 1)), supportCount: Number(group.support), calibrationState: version.calibration_json?.state ?? "provisional", distributionState: "in_distribution", prediction: { medianDurationMs: Number(group.median), intervalP10P90Ms: [Number(group.p10), Number(group.p90)] }, explanation: { technique: version.technique, deterministicClassification: classification, support: group.support, intervalMeaning: "empirical p10-p90, not a deterministic deadline", safetyAuthority: "deterministic_controller" } }));
      }
    } else {
      const group = artifact.byClassification?.[classification] ?? null;
      const posterior = group?.posterior ?? null;
      if (!group || !posterior || Number(group.support ?? 0) < Math.max(5, Math.floor(Number(model.minimum_support) / 4))) {
        results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: "out_of_distribution", supportCount: Number(group?.support ?? 0), calibrationState: version.calibration_json?.state ?? "unavailable", distributionState: "out_of_distribution", explanation: { reason: "insufficient_dependency_impact_support_for_classification", deterministicClassification: classification, safetyAuthority: "deterministic_controller" } }));
      } else {
        const probability = Number(posterior.mean);
        results.push(await persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `${family}:${plan.id}`, subjectType: "operational_change_plan", subjectId: plan.id, status: "ready", predictedLabel: probability >= 0.5 ? "downstream_impact_likely" : "downstream_impact_less_likely", probability, lower: Number(posterior.lower), upper: Number(posterior.upper), estimate: Number(group.impactCountMedian ?? 0), confidence: Math.min(1, Number(group.support) / Math.max(Number(model.minimum_support), 1)), supportCount: Number(group.support), calibrationState: version.calibration_json?.state ?? "provisional", distributionState: "in_distribution", prediction: { downstreamImpactProbability: probability, impactCountMedian: Number(group.impactCountMedian ?? 0), impactCountP90: Number(group.impactCountP90 ?? 0), interval: [Number(posterior.lower), Number(posterior.upper)] }, explanation: { technique: version.technique, deterministicClassification: classification, support: group.support, deterministicTopologyRemainsAuthority: true, safetyAuthority: "deterministic_controller" } }));
      }
    }
  }
  if (params.actorId) await logPlatformEvent({ workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "operational.ml.plan_predicted", entityType: "operational_change_plan", entityId: plan.id, metadata: { predictionIds: results.map((item) => item.id), statuses: results.map((item) => item.status), deterministicClassification: plan.deterministic_classification } });
  return { plan: { id: plan.id, deterministicClassification: plan.deterministic_classification, requiresApproval: plan.requires_approval, checksum: plan.plan_checksum_sha256 }, featureSnapshot: snapshot, predictions: results, deterministicSafetyAuthority: true };
}

export async function predictRemediationSuccess(params: { workspaceId: string; environmentId: string; remediationKey: string; subjectId?: string | null; actorId?: string | null }) {
  await ensureOperationalModelRegistry(params.workspaceId);
  const policy = await getOperationalLearningPolicy(params.workspaceId);
  const snapshot = await captureOperationalFeatureSnapshot({ workspaceId: params.workspaceId, environmentId: params.environmentId, featureFamily: "remediation_prediction_v1" });
  const { model, version } = await deployedModel(params.workspaceId, "remediation_success");
  if (!model) throw Object.assign(new Error("Remediation success model is not registered"), { status: 409 });
  if (!policy.local_learning_enabled || !version) return persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, snapshot, predictionKey: `remediation_success:${params.remediationKey}:${params.subjectId ?? "none"}`, subjectType: "remediation_candidate", subjectId: params.subjectId ?? null, status: policy.local_learning_enabled ? "insufficient_data" : "disabled", distributionState: "low_support", explanation: { remediationKey: params.remediationKey, reason: policy.local_learning_enabled ? "no_validated_deployed_model" : "local_learning_disabled", safetyAuthority: "deterministic_controller" } });
  const posterior = version.artifact_json?.byKey?.[params.remediationKey]?.posterior;
  if (!posterior || Number(posterior.support ?? 0) < Math.max(4, Math.floor(Number(model.minimum_support) / 4))) return persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `remediation_success:${params.remediationKey}:${params.subjectId ?? "none"}`, subjectType: "remediation_candidate", subjectId: params.subjectId ?? null, status: "out_of_distribution", supportCount: Number(posterior?.support ?? 0), calibrationState: version.calibration_json?.state ?? "unavailable", distributionState: "out_of_distribution", explanation: { remediationKey: params.remediationKey, reason: "insufficient_support_for_remediation_key", safetyAuthority: "deterministic_controller" } });
  return persistPrediction({ workspaceId: params.workspaceId, environmentId: params.environmentId, model, version, snapshot, predictionKey: `remediation_success:${params.remediationKey}:${params.subjectId ?? "none"}`, subjectType: "remediation_candidate", subjectId: params.subjectId ?? null, status: "ready", probability: Number(posterior.mean), lower: Number(posterior.lower), upper: Number(posterior.upper), confidence: Math.min(1, Number(posterior.support) / Math.max(Number(model.minimum_support), 1)), supportCount: Number(posterior.support), calibrationState: version.calibration_json?.state ?? "provisional", distributionState: "in_distribution", prediction: { successProbability: Number(posterior.mean), interval: [Number(posterior.lower), Number(posterior.upper)] }, explanation: { remediationKey: params.remediationKey, technique: version.technique, support: posterior.support, predictionCannotAuthorizeRepair: true, safetyAuthority: "deterministic_controller" } });
}

export async function listOperationalMlOverview(workspaceId: string, environmentId: string) {
  const models = await ensureOperationalModelRegistry(workspaceId);
  const [policy, rows] = await Promise.all([getOperationalLearningPolicy(workspaceId), mlData.overviewRows(workspaceId, environmentId)]);
  return { policy, models, ...rows };
}

export async function recordPlanPredictionOutcomes(params: { workspaceId: string; environmentId: string; planId: string; executionRunId: string; status: string; durationMs: number | null; downstreamImpactCount?: number | null; observedAt?: string }) {
  const predictions = await mlData.planPredictions(params.workspaceId, params.environmentId, params.planId);
  const observedAt = params.observedAt ?? new Date().toISOString();
  const adverse = params.status === "succeeded" ? 0 : 1;
  const rows = predictions.filter((prediction) => prediction.status === "ready").map((prediction) => {
    const evaluation: Record<string, unknown> = { executionRunId: params.executionRunId, actualStatus: params.status };
    if (prediction.probability !== null && prediction.probability !== undefined) {
      const probability = Math.max(1e-6, Math.min(1 - 1e-6, Number(prediction.probability)));
      const probabilityOutcome = String(prediction.prediction_key ?? "").startsWith("dependency_impact") ? (Number(params.downstreamImpactCount ?? 0) > 0 ? 1 : 0) : adverse;
      evaluation.actualProbabilityOutcome = probabilityOutcome;
      evaluation.probabilityTarget = String(prediction.prediction_key ?? "").startsWith("dependency_impact") ? "downstream_impact" : "adverse_execution_outcome";
      evaluation.brierComponent = (probability - probabilityOutcome) ** 2;
      evaluation.logLossComponent = -(probabilityOutcome * Math.log(probability) + (1 - probabilityOutcome) * Math.log(1 - probability));
    }
    if (prediction.estimate !== null && prediction.estimate !== undefined && params.durationMs !== null) {
      evaluation.actualDurationMs = params.durationMs;
      evaluation.absoluteErrorMs = Math.abs(Number(prediction.estimate) - params.durationMs);
      evaluation.insidePredictedInterval = prediction.interval_lower !== null && prediction.interval_upper !== null ? params.durationMs >= Number(prediction.interval_lower) && params.durationMs <= Number(prediction.interval_upper) : null;
    }
    return { workspace_id: params.workspaceId, prediction_id: prediction.id, outcome_json: { executionRunId: params.executionRunId, status: params.status, adverseOutcome: Boolean(adverse), downstreamImpactCount: params.downstreamImpactCount ?? null, durationMs: params.durationMs }, evaluation_json: evaluation, observed_at: observedAt };
  });
  await mlData.upsertOutcomes(rows);
  return { evaluatedPredictions: rows.length };
}
