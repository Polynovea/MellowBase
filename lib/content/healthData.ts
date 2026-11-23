// Content area: content-health findings, remediation tasks and health profiles, with the backend
// dispatcher (the `content` switch). healthService.ts keeps the scan rules and calls these.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/healthData.postgres";
import * as supabase from "@/lib/content/healthData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const callUpsertHealthFinding: typeof supabase.callUpsertHealthFinding = (...args) => impl().callUpsertHealthFinding(...args);
export const scanRows: typeof supabase.scanRows = (...args) => impl().scanRows(...args);
export const resolveUndetected: typeof supabase.resolveUndetected = (...args) => impl().resolveUndetected(...args);
export const overviewRows: typeof supabase.overviewRows = (...args) => impl().overviewRows(...args);
export const insertRemediationTask: typeof supabase.insertRemediationTask = (...args) => impl().insertRemediationTask(...args);
export const updateRemediationTaskRow: typeof supabase.updateRemediationTaskRow = (...args) => impl().updateRemediationTaskRow(...args);
export const callUpsertHealthProfile: typeof supabase.callUpsertHealthProfile = (...args) => impl().callUpsertHealthProfile(...args);
