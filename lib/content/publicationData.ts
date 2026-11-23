// Content area: publication targets and jobs, with the backend dispatcher (the `content` switch).
// publicationService.ts keeps config encryption, validation, signing, the request and the retry rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/publicationData.postgres";
import * as supabase from "@/lib/content/publicationData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const listTargets: typeof supabase.listTargets = (...args) => impl().listTargets(...args);
export const insertTarget: typeof supabase.insertTarget = (...args) => impl().insertTarget(...args);
export const queueJobs: typeof supabase.queueJobs = (...args) => impl().queueJobs(...args);
export const listJobs: typeof supabase.listJobs = (...args) => impl().listJobs(...args);
export const jobForDispatch: typeof supabase.jobForDispatch = (...args) => impl().jobForDispatch(...args);
export const markJobRunning: typeof supabase.markJobRunning = (...args) => impl().markJobRunning(...args);
export const recordJobOutcome: typeof supabase.recordJobOutcome = (...args) => impl().recordJobOutcome(...args);
