import { describe, expect, it, vi, beforeEach } from "vitest";
import { transitionWorkflow, getWorkflow } from "./workflowService";
import { callTransitionWorkflow, latestWorkflow } from "@/lib/content/workflowData";

// The service maps the transition function's SQLSTATE and message to an HTTP status; the function
// call itself is faked here (the real transitions are in workflowCollaboration.dual.test.ts).
vi.mock("@/lib/content/workflowData", () => ({
  callTransitionWorkflow: vi.fn(),
  latestWorkflow: vi.fn(),
  listWorkflowDefinitionRows: vi.fn(),
  upsertWorkflowDefinition: vi.fn(),
}));

describe("workflowService unit tests", () => {
  let mockRpc: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc = vi.mocked(callTransitionWorkflow);
  });

  it("1. calls cms_transition_workflow and returns ok: true with data", async () => {
    mockRpc.mockResolvedValue({ ok: true, data: { success: true, instance_id: "inst-1", state: "in_review" } });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "submit",
      comment: "Please review",
      canPublish: false,
    });

    expect(mockRpc).toHaveBeenCalledWith({
      p_workspace_id: "ws-1",
      p_actor_id: "actor-1",
      p_entry_id: "ent-1",
      p_action: "submit",
      p_comment: "Please review",
      p_can_publish: false,
    });
    expect(res).toEqual({
      ok: true,
      data: { success: true, instance_id: "inst-1", state: "in_review" },
    });
  });

  it("2. sets p_comment to null if comment is omitted or empty", async () => {
    mockRpc.mockResolvedValue({ ok: true, data: { success: true } });

    await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "submit",
      canPublish: false,
    });

    expect(mockRpc).toHaveBeenCalledWith(expect.objectContaining({ p_comment: null })
    );
  });

  it("3. passes canPublish: true when user possesses publish rights", async () => {
    mockRpc.mockResolvedValue({ ok: true, data: { success: true } });

    await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "approve",
      canPublish: true,
    });

    expect(mockRpc).toHaveBeenCalledWith(expect.objectContaining({ p_can_publish: true })
    );
  });

  it("4. maps code 40300 (self-approval forbidden) to status 403", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: "40300", message: "A requester cannot approve their own review" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "approve",
      canPublish: true,
    });

    expect(res).toEqual({
      ok: false,
      error: "A requester cannot approve their own review",
      status: 403,
    });
  });

  it("5. maps 'cannot approve' in message to status 403", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: null, message: "Self-approval check: cannot approve own submission" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "approve",
      canPublish: true,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
    }
  });

  it("6. maps code 40301 (publishing permission required) to status 403", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: "40301", message: "Publishing permission is required for review decisions" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "approve",
      canPublish: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
    }
  });

  it("7. maps code P0002 (entry/draft not found) to status 404", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: "P0002", message: "Entry with a draft is required" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "submit",
      canPublish: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
    }
  });

  it("8. maps code P0003 (workflow conflict / active review exists) to status 409", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: "P0003", message: "An active review already exists" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "submit",
      canPublish: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
    }
  });

  it("9. maps concurrent reviewer conflict error to status 409", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: "P0003", message: "Workflow state conflict: review has already been decided or completed" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-2",
      action: "request_changes",
      canPublish: true,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error).toContain("conflict");
    }
  });

  it("10. maps general unknown database errors to status 400", async () => {
    mockRpc.mockResolvedValue({ ok: false, code: "22023", message: "Unsupported workflow action: bogus" });

    const res = await transitionWorkflow({
      workspaceId: "ws-1",
      entryId: "ent-1",
      actorId: "actor-1",
      action: "submit" as any,
      canPublish: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
    }
  });

  it("11. getWorkflow returns the entry's latest instance, read within the workspace", async () => {
    const instance = { id: "inst-1", current_state: "in_review", workflow_actions: [{ id: "act-1", action: "submitted" }] };
    vi.mocked(latestWorkflow).mockResolvedValue(instance as never);

    const wf = await getWorkflow("ws-1", "ent-123");

    expect(latestWorkflow).toHaveBeenCalledWith("ws-1", "ent-123");
    expect(wf?.id).toBe("inst-1");
  });

  it("12. getWorkflow returns null when no workflow instance exists", async () => {
    vi.mocked(latestWorkflow).mockResolvedValue(null as never);

    const wf = await getWorkflow("ws-1", "ent-456");
    expect(wf).toBeNull();
  });
});
