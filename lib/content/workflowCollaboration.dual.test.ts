import { describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import { createEntry } from "@/lib/content/entryService";
import { getWorkflow, transitionWorkflow } from "@/lib/content/workflowService";
import { listWorkflowDefinitions, saveWorkflowDefinition } from "@/lib/content/workflowDefinitionService";
import { addComment, assignEntry, getEntryCollaboration, getMyEditorialQueue, markEditorialNotificationsRead, resolveComment, setWatch } from "@/lib/content/collaborationService";
import { createModel } from "@/lib/schema/modelService";

const recorder = createRecorder();

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const suffix = crypto.randomUUID().slice(0, 8);
  const [colleague] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $2) returning id", [`colleague-${suffix}`, `colleague-${suffix}@example.test`]);
  await backend.query("insert into workspace_members (workspace_id, admin_user_id) values ($1, $2), ($1, $3)", [workspaceId, adminUserId, colleague.id]);
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Story", apiKey: "story", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title: "Draft" }, actorAdminUserId: adminUserId });
  if (!entry.ok) throw new Error(entry.error);
  return { workspaceId, adminUserId, colleagueId: colleague.id, modelId: model.data.model.id, entryId: entry.data.entry.id };
}

describeBothBackends(["content", "schema"], "editorial workflow and collaboration", (backend) => {
  it("saves workflow definitions and runs a workflow, read back with its actions and definition", async () => {
    const { workspaceId, adminUserId, modelId, entryId } = await setup(backend);
    const saved = await saveWorkflowDefinition({ workspaceId, actorId: adminUserId, name: " Review ", contentModelId: modelId, definition: { self_approval: true, approval_stages: [{ label: "Editor", required_approvals: 1 }] } });
    expect(saved).toBeTruthy();
    const definitions = await listWorkflowDefinitions(workspaceId);
    expect(definitions).toEqual([expect.objectContaining({ name: "Review", content_models: { id: modelId, name: "Story", api_key: "story" } })]);
    expect(definitions[0].definition_json.approval_stages[0]).toMatchObject({ key: "editor", required_approvals: 1 });

    expect(await getWorkflow(workspaceId, entryId)).toBeNull();
    const submitted = await transitionWorkflow({ workspaceId, entryId, actorId: adminUserId, action: "submit", comment: "Ready", canPublish: true });
    expect(submitted.ok).toBe(true);
    const workflow = await getWorkflow(workspaceId, entryId);
    expect(workflow).toMatchObject({ entry_id: entryId, workflow_definitions: { name: "Review" } });
    expect(workflow.workflow_actions.length).toBeGreaterThan(0);
    expect(Array.isArray(workflow.workflow_stage_approvals)).toBe(true);
    const again = await transitionWorkflow({ workspaceId, entryId, actorId: adminUserId, action: "submit", canPublish: true });
    expect(again).toMatchObject({ ok: false });

    const other = await backend.createWorkspace();
    expect(await getWorkflow(other.workspaceId, entryId)).toBeNull();
    expect(await listWorkflowDefinitions(other.workspaceId)).toEqual([]);
    recorder.record(backend.name, "workflow", { keys: Object.keys(workflow).sort(), definitionKeys: Object.keys(definitions[0]).sort(), againStatus: again.ok ? null : again.status });
  });

  it("assigns, comments with mentions of members only, resolves, watches and serves the editorial queue", async () => {
    const { workspaceId, adminUserId, colleagueId, entryId } = await setup(backend);
    const outsider = await backend.createWorkspace();

    expect(await assignEntry({ workspaceId, entryId, actorId: adminUserId, assigneeId: outsider.adminUserId, role: "reviewer" })).toMatchObject({ ok: false, status: 400 });
    const assigned = await assignEntry({ workspaceId, entryId, actorId: adminUserId, assigneeId: colleagueId, role: "reviewer", dueAt: "2030-01-01T00:00:00Z", note: " soon " });
    expect(assigned).toMatchObject({ ok: true, data: { role: "reviewer", note: "soon", status: "active" } });

    const comment = await addComment({ workspaceId, entryId, actorId: adminUserId, body: " Looks good ", mentionIds: [colleagueId, outsider.adminUserId, adminUserId] });
    if (!comment.ok) throw new Error(comment.error);
    const commentId = (comment.data as { id: string }).id;
    expect(await addComment({ workspaceId, entryId, actorId: adminUserId, body: "Reply", parentCommentId: crypto.randomUUID() })).toMatchObject({ ok: false, status: 400 });
    // The outsider was not mentioned and got no notification.
    expect(await backend.query("select 1 from editorial_notifications where recipient_admin_user_id = $1", [outsider.adminUserId])).toEqual([]);

    const collaboration = await getEntryCollaboration(workspaceId, entryId);
    if (!collaboration.ok) throw new Error(collaboration.error);
    const data = collaboration.data as { assignments: unknown[]; comments: Array<{ body: string; content_comment_mentions: Array<{ mentioned_admin_user_id: string }> }>; watcherAdminUserIds: string[] };
    expect(data.comments).toEqual([expect.objectContaining({ body: "Looks good", content_comment_mentions: [{ mentioned_admin_user_id: colleagueId }] })]);

    expect(await setWatch({ workspaceId, entryId, actorId: adminUserId, watching: true })).toEqual({ ok: true, data: { watching: true } });
    expect(((await getEntryCollaboration(workspaceId, entryId)) as { data: { watcherAdminUserIds: string[] } }).data.watcherAdminUserIds).toEqual([adminUserId]);
    expect(await resolveComment({ workspaceId, entryId, commentId, actorId: adminUserId })).toMatchObject({ ok: true, data: { status: "resolved" } });
    expect(await resolveComment({ workspaceId, entryId, commentId, actorId: adminUserId })).toMatchObject({ ok: false, status: 404 });

    const queue = await getMyEditorialQueue(workspaceId, colleagueId);
    if (!queue.ok) throw new Error(queue.error);
    const q = queue.data as { assignments: Array<{ content_entries: unknown }>; notifications: Array<{ kind: string; id: string }> };
    expect(q.assignments).toEqual([expect.objectContaining({ role: "reviewer", content_entries: { status: "draft", content_models: { name: "Story", api_key: "story" } } })]);
    expect(q.notifications.map((n) => n.kind).sort()).toEqual(["assignment", "mention"]);
    expect(await markEditorialNotificationsRead({ workspaceId, actorId: colleagueId })).toMatchObject({ ok: false, status: 400 });
    expect(await markEditorialNotificationsRead({ workspaceId, actorId: colleagueId, all: true })).toEqual({ ok: true, data: { updated: 2 } });
    recorder.record(backend.name, "collaboration", { assigned: assigned.ok && Object.keys(assigned.data as object).sort(), queueKeys: Object.keys(q.assignments[0]).sort(), comment: { ...(comment.data as object), id: "<id>" } });

    // Another workspace cannot read or act on the entry.
    expect(await getEntryCollaboration(outsider.workspaceId, entryId)).toMatchObject({ ok: false, status: 404 });
    expect(await addComment({ workspaceId: outsider.workspaceId, entryId, actorId: outsider.adminUserId, body: "x" })).toMatchObject({ ok: false, status: 404 });
    expect(await resolveComment({ workspaceId: outsider.workspaceId, entryId, commentId, actorId: outsider.adminUserId })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("workflow and collaboration backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
