// Content area, editorial workflow: database primitives with the backend dispatcher (the `content`
// switch). workflowService.ts and workflowDefinitionService.ts keep their rules (error-to-status
// mapping, definition normalization) and call these.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/workflowData.postgres";
import * as supabase from "@/lib/content/workflowData.supabase";

/** The function's result, or its SQLSTATE and a message that is safe to show. */
export type WorkflowFunctionResult = { ok: true; data: unknown } | { ok: false; code: string | null; message: string | null };

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const latestWorkflow: typeof supabase.latestWorkflow = (...args) => impl().latestWorkflow(...args);
export const callTransitionWorkflow: typeof supabase.callTransitionWorkflow = (...args) => impl().callTransitionWorkflow(...args);
export const listWorkflowDefinitionRows: typeof supabase.listWorkflowDefinitionRows = (...args) => impl().listWorkflowDefinitionRows(...args);
export const upsertWorkflowDefinition: typeof supabase.upsertWorkflowDefinition = (...args) => impl().upsertWorkflowDefinition(...args);
