import * as mlGovernanceData from "@/lib/intelligence/mlGovernanceData";
import { getOperationalLearningPolicy } from "@/lib/intelligence/operationalMlService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function calibrationError(rows: Array<{ probability: number; outcome: number }>, bins = 5) {
  if (!rows.length) return null;
  let weighted = 0;
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const bucket = rows.filter((row) => row.probability >= lo && (i === bins - 1 ? row.probability <= hi : row.probability < hi));
    if (!bucket.length) continue;
    const confidence = bucket.reduce((sum, row) => sum + row.probability, 0) / bucket.length;
    const accuracy = bucket.reduce((sum, row) => sum + row.outcome, 0) / bucket.length;
    weighted += (bucket.length / rows.length) * Math.abs(confidence - accuracy);
  }
  return weighted;
}

export async function enforceOperationalLearningRetention(workspaceId: string) {
  const policy = await getOperationalLearningPolicy(workspaceId);
  const cutoff = new Date(Date.now() - Number(policy.retention_days) * 86400000).toISOString();
  const deleted = await mlGovernanceData.deleteExpiredLearningData(workspaceId, cutoff);
  return { cutoff, retentionDays: policy.retention_days, deleted };
}

export async function recordPredictionFeedback(params: {
  workspaceId: string;
  actorId: string;
  predictionId: string;
  feedbackType: "accepted" | "rejected" | "corrected" | "overridden";
  correctedLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const prediction = UUID.test(params.predictionId) ? await mlGovernanceData.predictionForFeedback(params.workspaceId, params.predictionId) : null;
  if (!prediction) throw Object.assign(new Error("Prediction not found"), { status: 404 });
  return mlGovernanceData.insertFeedback({
    workspace_id: params.workspaceId,
    prediction_id: params.predictionId,
    feedback_type: params.feedbackType,
    corrected_label: params.correctedLabel ?? null,
    reason: params.reason?.slice(0, 2000) ?? null,
    metadata_json: params.metadata ?? {},
    created_by: params.actorId,
  }, {
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorId,
    action: "operational.ml.feedback.recorded",
    entityType: "operational_prediction",
    entityId: params.predictionId,
    metadata: { feedbackType: params.feedbackType, modelVersionId: prediction.model_version_id, featureSnapshotId: prediction.feature_snapshot_id },
  });
}

export async function refreshOnlineModelEvaluations(workspaceId: string, environmentId: string) {
  if (!UUID.test(environmentId)) return { evaluations: [] };
  const { predictions, outcomes } = await mlGovernanceData.evaluationInputs(workspaceId, environmentId);
  if (!predictions.length) return { evaluations: [] };
  const outcomeByPrediction = new Map(outcomes.map((row) => [row.prediction_id, row]));
  const groups = new Map<string, Array<{ prediction: any; outcome: any }>>();
  for (const prediction of predictions) {
    const outcome = outcomeByPrediction.get(prediction.id);
    if (!outcome || !prediction.model_version_id) continue;
    const rows = groups.get(prediction.model_version_id) ?? [];
    rows.push({ prediction, outcome });
    groups.set(prediction.model_version_id, rows);
  }
  const evaluations: any[] = [];
  for (const [modelVersionId, rows] of groups) {
    const probabilityRows = rows.flatMap(({ prediction, outcome }) => { if (prediction.probability == null) return []; const target = String(prediction.prediction_key ?? "").startsWith("dependency_impact") ? (Number(outcome.outcome_json?.downstreamImpactCount ?? 0) > 0 ? 1 : 0) : (outcome.outcome_json?.adverseOutcome ? 1 : 0); return [{ probability: Number(prediction.probability), outcome: target }]; });
    const durationRows = rows.flatMap(({ prediction, outcome }) => prediction.estimate == null || outcome.outcome_json?.durationMs == null ? [] : [{ predicted: Number(prediction.estimate), actual: Number(outcome.outcome_json.durationMs), inside: prediction.interval_lower != null && prediction.interval_upper != null ? Number(outcome.outcome_json.durationMs) >= Number(prediction.interval_lower) && Number(outcome.outcome_json.durationMs) <= Number(prediction.interval_upper) : null }]);
    const brier = probabilityRows.length ? probabilityRows.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / probabilityRows.length : null;
    const ece = calibrationError(probabilityRows);
    const mae = durationRows.length ? durationRows.reduce((sum, row) => sum + Math.abs(row.predicted - row.actual), 0) / durationRows.length : null;
    const intervalRows = durationRows.filter((row) => row.inside !== null);
    const intervalCoverage = intervalRows.length ? intervalRows.filter((row) => row.inside).length / intervalRows.length : null;
    const reviewRequired = rows.length >= 20 && ((brier != null && brier > 0.30) || (ece != null && ece > 0.15) || (intervalCoverage != null && intervalCoverage < 0.60));
    const metrics = { sampleCount: rows.length, brierScore: brier, expectedCalibrationError: ece, meanAbsoluteErrorMs: mae, intervalCoverage, reviewRequired };
    const evaluation = await mlGovernanceData.insertEvaluation({
      workspace_id: workspaceId,
      model_version_id: modelVersionId,
      evaluation_kind: "online",
      sample_count: rows.length,
      metrics_json: metrics,
      distribution_json: { environmentId, reviewRequired, automaticRetraining: false },
      status: reviewRequired ? "warning" : "recorded",
    });
    evaluations.push(evaluation);
  }
  return { evaluations };
}

export async function listOperationalMlFeedback(workspaceId: string, environmentId: string) {
  return UUID.test(environmentId) ? mlGovernanceData.feedbackFor(workspaceId, environmentId) : [];
}
