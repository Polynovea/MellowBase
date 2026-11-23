import * as discoveryData from "@/lib/intelligence/discoveryData";
import { listOperationalPlans, getAutonomyPolicy } from "@/lib/intelligence/planningService";
import { listDesiredStateRevisions, listOperationalDrift } from "@/lib/intelligence/reconciliationService";
import { getOperationalWorldModel } from "@/lib/intelligence/worldModelService";
import { listDataAwareChangeAssessments } from "@/lib/intelligence/migrationIntelligenceService";
import { listRemediationRegistry } from "@/lib/intelligence/remediationService";
import { listMigrationRuns } from "@/lib/intelligence/migrationStrategyService";
import { listOperationalPlanComparisons } from "@/lib/intelligence/predictivePlanningService";
import { listOperationalMlFeedback } from "@/lib/intelligence/operationalMlGovernanceService";
import { listOperationalMlOverview } from "@/lib/intelligence/operationalMlService";

export async function getOperationalIntelligenceOverview(workspaceId: string, environmentId: string) {
  const mlPromise = listOperationalMlOverview(workspaceId, environmentId).catch((error) => ({
    available: false,
    status: "unavailable",
    reason: error instanceof Error ? error.message : "Operational ML is unavailable",
    policy: null,
    models: [],
    modelVersions: [],
    predictions: [],
    featureSnapshots: [],
    evaluations: [],
  }));

  const [world, desiredStates, drift, planning, policy, runs, assessments, remediationRegistry, migrationRuns, planComparisons, mlFeedback, ml] = await Promise.all([
    getOperationalWorldModel(workspaceId, environmentId),
    listDesiredStateRevisions(workspaceId, environmentId),
    listOperationalDrift(workspaceId, environmentId),
    listOperationalPlans(workspaceId, environmentId),
    getAutonomyPolicy(workspaceId, environmentId),
    discoveryData.overviewRuns(workspaceId, environmentId),
    listDataAwareChangeAssessments(workspaceId, environmentId),
    listRemediationRegistry(),
    listMigrationRuns(workspaceId, environmentId),
    listOperationalPlanComparisons(workspaceId, environmentId),
    listOperationalMlFeedback(workspaceId, environmentId).catch(() => []),
    mlPromise,
  ]);

  return {
    world,
    desiredStates,
    activeDesiredState: desiredStates.find((item: any) => item.status === "active") ?? null,
    drift,
    policy,
    reconciliationRuns: runs.reconciliationRuns,
    discoveryRuns: runs.discoveryRuns,
    changeAssessments: assessments,
    remediationRuns: runs.remediationRuns,
    remediationRegistry,
    operationalEvents: runs.operationalEvents,
    migrationRuns,
    planComparisons,
    mlFeedback,
    ml: "available" in ml ? ml : { available: true, status: "available", ...ml },
    ...planning,
  };
}
