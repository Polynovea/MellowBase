// Intelligence area: deterministic remediation registry and runs, with the backend dispatcher (the
// `intelligence` switch). remediationService.ts keeps the policy gates, executors and verification.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/remediationData.postgres";
import * as supabase from "@/lib/intelligence/remediationData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const enabledRegistry: typeof supabase.enabledRegistry = (...args) => impl().enabledRegistry(...args);
export const registryEntry: typeof supabase.registryEntry = (...args) => impl().registryEntry(...args);
export const driftInEnvironment: typeof supabase.driftInEnvironment = (...args) => impl().driftInEnvironment(...args);
export const startRun: typeof supabase.startRun = (...args) => impl().startRun(...args);
export const completeRun: typeof supabase.completeRun = (...args) => impl().completeRun(...args);
export const failRun: typeof supabase.failRun = (...args) => impl().failRun(...args);
export const autoRepairRows: typeof supabase.autoRepairRows = (...args) => impl().autoRepairRows(...args);
