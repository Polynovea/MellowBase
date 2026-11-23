// Direct PostgreSQL implementation of the editorial workflow primitives (phase 1, wave 3).
//
// Same signatures and return shapes as workflowData.supabase.ts. The embeds become explicit queries:
// - workflow_instances has no workspace_id: the instance is read through its entry's workspace;
// - workflow_actions and workflow_stage_approvals have none either: read through that instance;
// - the definition is joined on (id) and must be in the same workspace;
// - definitions list their model on (model id, workspace id).
// Child lists come back in a fixed order (created_at, id). The transition and upsert functions' own
// messages pass through with their SQLSTATE; database text never does.
import { callFunction, DEFAULT_LIST_LIMIT, getDb, maybeOne, SqlFunctionError } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import type { WorkflowFunctionResult } from "@/lib/content/workflowData";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through to the API as before */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function latestWorkflow(workspaceId: string, entryId: string): Promise<any | null> {
  if (!UUID.test(entryId)) return null;
  const db = getDb();
  const instance = maybeOne(await db.selectFrom("workflow_instances as w")
    .innerJoin("content_entries as e", "e.id", "w.entry_id")
    .selectAll("w")
    .where("e.workspace_id", "=", workspaceId).where("w.entry_id", "=", entryId)
    .orderBy("w.started_at", "desc").orderBy("w.id", "desc").limit(1).execute());
  if (!instance) return null;
  const [actions, approvals, definition] = await Promise.all([
    db.selectFrom("workflow_actions").selectAll().where("workflow_instance_id", "=", instance.id).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("workflow_stage_approvals").selectAll().where("workflow_instance_id", "=", instance.id).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("workflow_definitions").select(["id", "name", "definition_json"])
      .where("id", "=", instance.workflow_definition_id).where("workspace_id", "=", workspaceId).execute().then((rows) => maybeOne(rows)),
  ]);
  return { ...instance, workflow_actions: actions, workflow_stage_approvals: approvals, workflow_definitions: definition ?? null };
}

export async function callTransitionWorkflow(args: Record<string, unknown>): Promise<WorkflowFunctionResult> {
  try {
    return { ok: true, data: await callFunction("cms_transition_workflow", args as never) };
  } catch (error) {
    if (error instanceof SqlFunctionError) return { ok: false, code: error.sqlState, message: error.message };
    return { ok: false, code: null, message: clientErrorMessage(error, "Workflow transition failed") };
  }
}

export async function listWorkflowDefinitionRows(workspaceId: string): Promise<any[]> {
  const rows = await getDb().selectFrom("workflow_definitions as d")
    .leftJoin("content_models as m", (join) => join.onRef("m.id", "=", "d.content_model_id").onRef("m.workspace_id", "=", "d.workspace_id"))
    .selectAll("d")
    .select(["m.id as model_id", "m.name as model_name", "m.api_key as model_api_key"])
    .where("d.workspace_id", "=", workspaceId)
    .orderBy("d.active", "desc").orderBy("d.updated_at", "desc").orderBy("d.id").limit(DEFAULT_LIST_LIMIT).execute();
  return rows.map(({ model_id, model_name, model_api_key, ...definition }) => ({
    ...definition,
    content_models: model_id ? { id: model_id, name: model_name, api_key: model_api_key } : null,
  }));
}

export async function upsertWorkflowDefinition(args: Record<string, unknown>): Promise<unknown> {
  try {
    const data = await callFunction("cms_upsert_workflow_definition", { ...args, p_definition: JSON.stringify(args.p_definition) } as never);
    if (!data) throw new Error("Could not save workflow definition");
    return data;
  } catch (error) {
    if (error instanceof SqlFunctionError) throw error;
    throw new Error(clientErrorMessage(error, "Could not save workflow definition"));
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
