// Intelligence area: operational ML policies, registry, feature snapshots, model versions,
// predictions and outcomes, with the backend dispatcher (the `intelligence` switch).
// operationalMlService.ts keeps the feature computation, trainers and prediction rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/mlData.postgres";
import * as supabase from "@/lib/intelligence/mlData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const learningPolicy: typeof supabase.learningPolicy = (...args) => impl().learningPolicy(...args);
export const saveLearningPolicy: typeof supabase.saveLearningPolicy = (...args) => impl().saveLearningPolicy(...args);
export const ensureRegistry: typeof supabase.ensureRegistry = (...args) => impl().ensureRegistry(...args);
export const localEvents: typeof supabase.localEvents = (...args) => impl().localEvents(...args);
export const snapshotInputs: typeof supabase.snapshotInputs = (...args) => impl().snapshotInputs(...args);
export const insertSnapshot: typeof supabase.insertSnapshot = (...args) => impl().insertSnapshot(...args);
export const persistModelVersion: typeof supabase.persistModelVersion = (...args) => impl().persistModelVersion(...args);
export const deployedModelRows: typeof supabase.deployedModelRows = (...args) => impl().deployedModelRows(...args);
export const failDeployedVersion: typeof supabase.failDeployedVersion = (...args) => impl().failDeployedVersion(...args);
export const insertPrediction: typeof supabase.insertPrediction = (...args) => impl().insertPrediction(...args);
export const planForPrediction: typeof supabase.planForPrediction = (...args) => impl().planForPrediction(...args);
export const overviewRows: typeof supabase.overviewRows = (...args) => impl().overviewRows(...args);
export const planPredictions: typeof supabase.planPredictions = (...args) => impl().planPredictions(...args);
export const upsertOutcomes: typeof supabase.upsertOutcomes = (...args) => impl().upsertOutcomes(...args);
