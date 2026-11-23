// Intelligence area: migration strategy runs and batches, with the backend dispatcher (the
// `intelligence` switch). migrationStrategyService.ts keeps validation, transforms and batching rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/migrationRunData.postgres";
import * as supabase from "@/lib/intelligence/migrationRunData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const reusableRun: typeof supabase.reusableRun = (...args) => impl().reusableRun(...args);
export const insertRun: typeof supabase.insertRun = (...args) => impl().insertRun(...args);
export const updateRun: typeof supabase.updateRun = (...args) => impl().updateRun(...args);
export const completeRun: typeof supabase.completeRun = (...args) => impl().completeRun(...args);
export const entryBatch: typeof supabase.entryBatch = (...args) => impl().entryBatch(...args);
export const startBatch: typeof supabase.startBatch = (...args) => impl().startBatch(...args);
export const finishBatch: typeof supabase.finishBatch = (...args) => impl().finishBatch(...args);
export const listRuns: typeof supabase.listRuns = (...args) => impl().listRuns(...args);
