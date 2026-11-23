// Intelligence area: autonomy policies and operational plans (creation, graph, lists), with the
// backend dispatcher (the `intelligence` switch). planningService.ts keeps plan derivation and rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/planData.postgres";
import * as supabase from "@/lib/intelligence/planData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const autonomyPolicy: typeof supabase.autonomyPolicy = (...args) => impl().autonomyPolicy(...args);
export const saveAutonomyPolicy: typeof supabase.saveAutonomyPolicy = (...args) => impl().saveAutonomyPolicy(...args);
export const reconciliationRunInEnvironment: typeof supabase.reconciliationRunInEnvironment = (...args) => impl().reconciliationRunInEnvironment(...args);
export const planInputs: typeof supabase.planInputs = (...args) => impl().planInputs(...args);
export const planByChecksum: typeof supabase.planByChecksum = (...args) => impl().planByChecksum(...args);
export const persistPlan: typeof supabase.persistPlan = (...args) => impl().persistPlan(...args);
export const planGraph: typeof supabase.planGraph = (...args) => impl().planGraph(...args);
export const planLists: typeof supabase.planLists = (...args) => impl().planLists(...args);
