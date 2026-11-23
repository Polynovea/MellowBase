// Intelligence area: ML governance (retention, feedback, online evaluation) and predictive plan
// comparisons, with the backend dispatcher (the `intelligence` switch). The metrics, scenario
// building and ranking stay in operationalMlGovernanceService.ts and predictivePlanningService.ts.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/mlGovernanceData.postgres";
import * as supabase from "@/lib/intelligence/mlGovernanceData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const deleteExpiredLearningData: typeof supabase.deleteExpiredLearningData = (...args) => impl().deleteExpiredLearningData(...args);
export const predictionForFeedback: typeof supabase.predictionForFeedback = (...args) => impl().predictionForFeedback(...args);
export const insertFeedback: typeof supabase.insertFeedback = (...args) => impl().insertFeedback(...args);
export const evaluationInputs: typeof supabase.evaluationInputs = (...args) => impl().evaluationInputs(...args);
export const insertEvaluation: typeof supabase.insertEvaluation = (...args) => impl().insertEvaluation(...args);
export const feedbackFor: typeof supabase.feedbackFor = (...args) => impl().feedbackFor(...args);
export const planWithNodes: typeof supabase.planWithNodes = (...args) => impl().planWithNodes(...args);
export const insertComparison: typeof supabase.insertComparison = (...args) => impl().insertComparison(...args);
export const comparisonById: typeof supabase.comparisonById = (...args) => impl().comparisonById(...args);
export const selectScenario: typeof supabase.selectScenario = (...args) => impl().selectScenario(...args);
export const listComparisons: typeof supabase.listComparisons = (...args) => impl().listComparisons(...args);
