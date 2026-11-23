// Intelligence area: desired-state revisions and reconciliation runs and drift, with the backend
// dispatcher (the `intelligence` switch). reconciliationService.ts keeps validation and drift rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/reconciliationData.postgres";
import * as supabase from "@/lib/intelligence/reconciliationData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const listRevisions: typeof supabase.listRevisions = (...args) => impl().listRevisions(...args);
export const activeRevision: typeof supabase.activeRevision = (...args) => impl().activeRevision(...args);
export const revisionById: typeof supabase.revisionById = (...args) => impl().revisionById(...args);
export const revisionByChecksum: typeof supabase.revisionByChecksum = (...args) => impl().revisionByChecksum(...args);
export const createRevision: typeof supabase.createRevision = (...args) => impl().createRevision(...args);
export const callActivateRevision: typeof supabase.callActivateRevision = (...args) => impl().callActivateRevision(...args);
export const environmentState: typeof supabase.environmentState = (...args) => impl().environmentState(...args);
export const startReconciliation: typeof supabase.startReconciliation = (...args) => impl().startReconciliation(...args);
export const applyReconciliation: typeof supabase.applyReconciliation = (...args) => impl().applyReconciliation(...args);
export const failReconciliation: typeof supabase.failReconciliation = (...args) => impl().failReconciliation(...args);
export const listDrift: typeof supabase.listDrift = (...args) => impl().listDrift(...args);
