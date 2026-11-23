import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { createEntry } from "@/lib/content/entryService";
import { createRemediationTask, getContentHealth, scanContentHealth, updateContentHealthProfile, updateRemediationTask } from "@/lib/content/healthService";
import { createModel } from "@/lib/schema/modelService";
const MISSING = "00000000-0000-4000-8000-000000000000";

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  await backend.query("insert into workspace_members (workspace_id, admin_user_id) values ($1, $2)", [workspaceId, adminUserId]);
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  if (!model.ok) throw new Error(model.error);
  const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title: "Health" }, actorAdminUserId: adminUserId });
  if (!entry.ok) throw new Error(entry.error);
  const [asset] = await backend.query<{ id: string }>(
    "insert into assets (workspace_id, filename, mime_type, size_bytes, storage_key, storage_provider, checksum) values ($1, 'orphan.png', 'image/png', 10, $2, 'local', 'abc') returning id",
    [workspaceId, `ws/${workspaceId}/orphan.png`],
  );
  return { workspaceId, adminUserId, entryId: entry.data.entry.id, assetId: asset.id };
}

const codes = (rows: Array<{ finding_code: string; state: string }>, state = "open") => rows.filter((row) => row.state === state).map((row) => row.finding_code).sort();

describeWithDatabase("content health", (backend) => {
  it("scans, records and resolves findings, and keeps profiles in the workspace", async () => {
    const { workspaceId, adminUserId, entryId, assetId } = await setup(backend);
    const first = await scanContentHealth({ workspaceId, actorId: adminUserId });
    expect(first).toMatchObject({ entries: 1, assets: 1, resolved: 0 });
    const before = await getContentHealth(workspaceId);
    expect(codes(before.findings)).toEqual(expect.arrayContaining(["missing_owner", "unused_asset"]));
    expect(before.findings.find((f) => f.finding_code === "unused_asset")).toMatchObject({ entity_id: assetId, severity: "info", evidence_json: { filename: "orphan.png", mimeType: "image/png" } });
    expect(before.summary.missingOwner).toBe(1);

    const other = await backend.createWorkspace();
    await expect(updateContentHealthProfile({ workspaceId, actorId: adminUserId, entryId, ownerId: other.adminUserId })).rejects.toThrow("Owner must be an active workspace member");
    await expect(updateContentHealthProfile({ workspaceId: other.workspaceId, actorId: other.adminUserId, entryId })).rejects.toThrow("Entry not found in workspace");
    await expect(updateContentHealthProfile({ workspaceId, actorId: adminUserId, entryId: "not-a-uuid" })).rejects.toThrow("Entry not found in workspace");
    const profile = await updateContentHealthProfile({ workspaceId, actorId: adminUserId, entryId, ownerId: adminUserId, reviewCadenceDays: 30 });
    expect(profile).toMatchObject({ entry_id: entryId, workspace_id: workspaceId, owner_id: adminUserId, review_cadence_days: 30 });

    // The owner fixes missing_owner; a cadence with no review raises review_never_completed.
    const second = await scanContentHealth({ workspaceId, actorId: adminUserId });
    expect(second.resolved).toBeGreaterThanOrEqual(1);
    const after = await getContentHealth(workspaceId);
    expect(codes(after.findings, "resolved")).toContain("missing_owner");
    expect(codes(after.findings)).toEqual(expect.arrayContaining(["review_never_completed", "unused_asset"]));
    expect(codes(after.findings)).not.toContain("missing_owner");
    expect(after.profiles.map((p) => p.entry_id)).toEqual([entryId]);

    // Another workspace's scan and overview see none of it.
    expect(await scanContentHealth({ workspaceId: other.workspaceId })).toEqual({ entries: 0, assets: 0, findingsWritten: 0, resolved: 0 });
    expect((await getContentHealth(other.workspaceId)).findings).toEqual([]);

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and action = 'content_health.scan_completed'", [workspaceId]);
    expect(events).toHaveLength(2);
  });

  it("creates and updates remediation tasks only against the workspace's own findings, entities and members", async () => {
    const { workspaceId, adminUserId, entryId, assetId } = await setup(backend);
    await scanContentHealth({ workspaceId });
    const finding = (await getContentHealth(workspaceId)).findings.find((f) => f.finding_code === "unused_asset");
    const other = await setup(backend);
    await scanContentHealth({ workspaceId: other.workspaceId });
    const foreignFinding = (await getContentHealth(other.workspaceId)).findings[0];

    const base = { workspaceId, actorId: adminUserId, entityType: "asset" as const, entityId: assetId, title: "Remove orphan" };
    await expect(createRemediationTask({ ...base, findingId: foreignFinding.id })).rejects.toThrow("Health finding not found in workspace");
    await expect(createRemediationTask({ ...base, entityId: other.assetId })).rejects.toThrow("Asset not found in workspace");
    await expect(createRemediationTask({ ...base, entityType: "entry", entityId: other.entryId })).rejects.toThrow("Entry not found in workspace");
    await expect(createRemediationTask({ ...base, assignedTo: other.adminUserId })).rejects.toThrow("Assignee must be an active workspace member");
    await expect(createRemediationTask({ ...base, findingId: "nope" })).rejects.toThrow("Health finding not found in workspace");
    await expect(createRemediationTask({ ...base, priority: "whenever" })).rejects.toThrow("Unsupported remediation task priority");
    await expect(createRemediationTask({ ...base, title: "  " })).rejects.toThrow("Task title is required");

    const task = await createRemediationTask({ ...base, title: " Remove orphan ", findingId: finding.id, assignedTo: adminUserId, priority: "high" });
    expect(task).toMatchObject({ workspace_id: workspaceId, finding_id: finding.id, entity_type: "asset", entity_id: assetId, title: "Remove orphan", status: "open", priority: "high", assigned_to: adminUserId, created_by: adminUserId });
    const entryTask = await createRemediationTask({ workspaceId, actorId: adminUserId, entityType: "entry", entityId: entryId, title: "Give it an owner" });
    expect(entryTask.finding_id).toBeNull();

    await expect(updateRemediationTask({ workspaceId: other.workspaceId, actorId: other.adminUserId, id: task.id, status: "done" })).rejects.toThrow("Remediation task not found");
    await expect(updateRemediationTask({ workspaceId, actorId: adminUserId, id: "nope", status: "done" })).rejects.toThrow("Remediation task not found");
    await expect(updateRemediationTask({ workspaceId, actorId: adminUserId, id: MISSING, status: "done" })).rejects.toThrow("Remediation task not found");
    await expect(updateRemediationTask({ workspaceId, actorId: adminUserId, id: task.id, assignedTo: other.adminUserId })).rejects.toThrow("Assignee must be an active workspace member");
    await expect(updateRemediationTask({ workspaceId, actorId: adminUserId, id: task.id, status: "resolved" })).rejects.toThrow("Unsupported remediation task status");
    const done = await updateRemediationTask({ workspaceId, actorId: adminUserId, id: task.id, status: "done", resolutionNote: "Deleted" });
    expect(done).toMatchObject({ id: task.id, status: "done", completed_by: adminUserId, resolution_note: "Deleted" });
    expect(done.completed_at).not.toBeNull();
    expect((await getContentHealth(workspaceId)).summary.openTasks).toBe(1);
    expect((await getContentHealth(other.workspaceId)).tasks).toEqual([]);

    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'content_remediation_task' order by created_at, action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["content_health.remediation_created", "content_health.remediation_created", "content_health.remediation_updated"]);
  });
});
