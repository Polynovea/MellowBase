// Intelligence area: data-aware change assessments, with the backend dispatcher (the `intelligence`
// switch). migrationIntelligenceService.ts keeps the profiling, classification and provenance rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/migrationIntelData.postgres";
import * as supabase from "@/lib/intelligence/migrationIntelData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const assessmentSources: typeof supabase.assessmentSources = (...args) => impl().assessmentSources(...args);
export const recordAssessment: typeof supabase.recordAssessment = (...args) => impl().recordAssessment(...args);
export const listAssessments: typeof supabase.listAssessments = (...args) => impl().listAssessments(...args);
