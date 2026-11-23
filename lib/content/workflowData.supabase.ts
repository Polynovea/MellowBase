// Supabase path of the editorial workflow primitives (queries moved from workflowService.ts and
// workflowDefinitionService.ts; deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import type { WorkflowFunctionResult } from "@/lib/content/workflowData";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through to the API as before */
/**
 * The entry's latest workflow instance with its actions, stage approvals and definition. The entry
 * must be in the workspace (workflow_instances has no workspace_id): an inner embed on the entry,
 * filtered by workspace, then stripped.
 */
export async function latestWorkflow(workspaceId: string, entryId: string): Promise<any | null> {
  const { data } = await createServiceRoleClient()
    .from("workflow_instances")
    .select("*, workflow_actions(*), workflow_stage_approvals(*), workflow_definitions(id,name,definition_json), content_entries!inner(workspace_id)")
    .eq("entry_id", entryId)
    .eq("content_entries.workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const { content_entries: _entry, ...workflow } = data;
  return workflow;
}

export async function callTransitionWorkflow(args: Record<string, unknown>): Promise<WorkflowFunctionResult> {
  const { data, error } = await createServiceRoleClient().rpc("cms_transition_workflow", args);
  if (error) return { ok: false, code: error.code ?? null, message: error.message ?? null };
  return { ok: true, data };
}

export async function listWorkflowDefinitionRows(workspaceId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient()
    .from("workflow_definitions")
    .select("*, content_models(id,name,api_key)")
    .eq("workspace_id", workspaceId)
    .order("active", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertWorkflowDefinition(args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await createServiceRoleClient().rpc("cms_upsert_workflow_definition", args);
  if (error || !data) throw new Error(error?.message || "Could not save workflow definition");
  return data;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
