// Content area, editorial workflow: database primitives. workflowService.ts and
// workflowDefinitionService.ts keep their rules (error-to-status mapping, definition normalization)
// and call these.
import * as postgres from "@/lib/content/workflowData.postgres";

/** The function's result, or its SQLSTATE and a message that is safe to show. */
export type WorkflowFunctionResult = { ok: true; data: unknown } | { ok: false; code: string | null; message: string | null };


export const latestWorkflow = postgres.latestWorkflow;
export const callTransitionWorkflow = postgres.callTransitionWorkflow;
export const listWorkflowDefinitionRows = postgres.listWorkflowDefinitionRows;
export const upsertWorkflowDefinition = postgres.upsertWorkflowDefinition;
