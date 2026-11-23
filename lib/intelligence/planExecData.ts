// Intelligence area: operational plan simulation and execution, with the backend dispatcher (the
// `intelligence` switch). planningService.ts keeps the gates, the execution DAG and node executors.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/planExecData.postgres";
import * as supabase from "@/lib/intelligence/planExecData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const approvedRequests: typeof supabase.approvedRequests = (...args) => impl().approvedRequests(...args);
export const latestSucceededDiscovery: typeof supabase.latestSucceededDiscovery = (...args) => impl().latestSucceededDiscovery(...args);
export const assessmentInEnvironment: typeof supabase.assessmentInEnvironment = (...args) => impl().assessmentInEnvironment(...args);
export const recordSimulation: typeof supabase.recordSimulation = (...args) => impl().recordSimulation(...args);
export const recordBlockedExecution: typeof supabase.recordBlockedExecution = (...args) => impl().recordBlockedExecution(...args);
export const startExecution: typeof supabase.startExecution = (...args) => impl().startExecution(...args);
export const updateNodeRun: typeof supabase.updateNodeRun = (...args) => impl().updateNodeRun(...args);
export const completeExecution: typeof supabase.completeExecution = (...args) => impl().completeExecution(...args);
export const auditExecution: typeof supabase.auditExecution = (...args) => impl().auditExecution(...args);
