// Intelligence area: discovery reads, canonical schema deployment and the overview's run lists, with
// the backend dispatcher (the `intelligence` switch). The probes, deployment gates and overview
// assembly stay in their services.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/discoveryData.postgres";
import * as supabase from "@/lib/intelligence/discoveryData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const changeAssessment: typeof supabase.changeAssessment = (...args) => impl().changeAssessment(...args);
export const environmentKind: typeof supabase.environmentKind = (...args) => impl().environmentKind(...args);
export const recordSchemaDeployment: typeof supabase.recordSchemaDeployment = (...args) => impl().recordSchemaDeployment(...args);
export const databaseConnections: typeof supabase.databaseConnections = (...args) => impl().databaseConnections(...args);
export const capabilityRows: typeof supabase.capabilityRows = (...args) => impl().capabilityRows(...args);
export const overviewRuns: typeof supabase.overviewRuns = (...args) => impl().overviewRuns(...args);
