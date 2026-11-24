import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { createEntry } from "@/lib/content/entryService";
import { createPreviewToken, createReleasePreviewToken, getReleasePreview, resolvePreviewToken } from "@/lib/content/previewService";
import { createSavedEntryView, deleteSavedEntryView, listSavedEntryViews } from "@/lib/content/savedViewService";
import { createRelease } from "@/lib/content/releaseService";
import { createModel } from "@/lib/schema/modelService";

async function setup(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  // Previews show what their issuer may read, so the issuer is an active member (phase 4).
  await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
  const model = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Page", apiKey: "page", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "internal_note", label: "Internal note", type: "text", required: false }] } });
  if (!model.ok) throw new Error(model.error);
  const entry = await createEntry({ workspaceId, modelId: model.data.model.id, data: { title: "Preview me" }, actorAdminUserId: adminUserId });
  if (!entry.ok) throw new Error(entry.error);
  return { workspaceId, adminUserId, modelId: model.data.model.id, entryId: entry.data.entry.id, versionId: entry.data.version.id };
}

describeWithDatabase("preview tokens, release previews and saved entry views", (backend) => {
  it("issues and resolves entry preview tokens, storing only the hash", async () => {
    const { workspaceId, adminUserId, entryId, versionId } = await setup(backend);
    const { token, expiresAt } = await createPreviewToken({ workspaceId, entryId, actorId: adminUserId, expiresInHours: 1000 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(168 * 3_600_000 + 5_000);
    expect(await backend.query("select 1 from preview_tokens where token_hash = $1", [token])).toEqual([]);

    const resolved = await resolvePreviewToken(token);
    expect(resolved).toMatchObject({ entry_id: entryId, entry_version_id: versionId, content_entry_versions: { id: versionId, data_jsonb: { title: "Preview me" } }, content_entries: { content_models: { name: "Page", api_key: "page" } } });
    expect(resolved.last_used_at).toBeNull(); // the row as it was read; last use is recorded after
    const [used] = await backend.query<{ last_used_at: string | null }>("select last_used_at from preview_tokens where id = $1", [resolved.id]);
    expect(used.last_used_at).not.toBeNull();
    expect(await resolvePreviewToken("not-a-real-token")).toBeNull();
    await backend.query("update preview_tokens set revoked_at = now() where id = $1", [resolved.id]);
    expect(await resolvePreviewToken(token)).toBeNull();

    const other = await backend.createWorkspace();
    await expect(createPreviewToken({ workspaceId: other.workspaceId, entryId, actorId: other.adminUserId })).rejects.toThrow("Entry draft not found");
  });

  it("previews a release with its pinned versions and models (empty on Supabase before this fix)", async () => {
    const { workspaceId, adminUserId, entryId, versionId } = await setup(backend);
    await backend.query("update content_entries set status = 'approved' where id = $1", [entryId]);
    const release = await createRelease({ workspaceId, actorId: adminUserId, name: "Preview release", itemVersionIds: [versionId] });
    if (!release.ok) throw new Error(release.error);
    const releaseId = (release.data as { id: string }).id;
    const preview = await getReleasePreview(workspaceId, releaseId, { adminUserId });
    expect(preview).toMatchObject({ id: releaseId, name: "Preview release", release_items: [{ entry_id: entryId, entry_version_id: versionId, content_entry_versions: { locale: "en", data_jsonb: { title: "Preview me" }, content_entries: { content_models: { name: "Page", api_key: "page" } } } }] });
    expect((await createReleasePreviewToken({ workspaceId, releaseId, actorId: adminUserId })).token).toBeTruthy();
    const other = await backend.createWorkspace();
    expect(await getReleasePreview(other.workspaceId, releaseId, { adminUserId: other.adminUserId })).toBeNull();
    await expect(createReleasePreviewToken({ workspaceId: other.workspaceId, releaseId, actorId: other.adminUserId })).rejects.toThrow("Release not found");
  });

  it("phase 4: a preview never shows a field hidden from its issuer, and shows nothing once the issuer has left", async () => {
    const { workspaceId, adminUserId, modelId, entryId } = await setup(backend);
    await backend.query("update content_entry_versions set data_jsonb = data_jsonb || '{\"internal_note\": \"do not ship\"}'::jsonb where entry_id = $1", [entryId]);
    const [role] = await backend.query<{ id: string }>("insert into roles (workspace_id, key, name) values ($1, 'reviewer', 'Reviewer') returning id", [workspaceId]);
    await backend.query("insert into member_roles (workspace_member_id, role_id) select id, $2 from workspace_members where workspace_id = $1 and admin_user_id = $3", [workspaceId, role.id, adminUserId]);
    await backend.query("insert into content_field_permissions (workspace_id, content_model_id, field_key, role_id, can_read, can_write) values ($1, $2, 'internal_note', $3, false, false)", [workspaceId, modelId, role.id]);
    const { token } = await createPreviewToken({ workspaceId, entryId, actorId: adminUserId });
    const resolved = await resolvePreviewToken(token);
    expect(resolved.content_entry_versions.data_jsonb).toEqual({ title: "Preview me" });
    expect(resolved.issuer_active).toBe(true);
    await backend.query("update workspace_members set status = 'suspended' where workspace_id = $1 and admin_user_id = $2", [workspaceId, adminUserId]);
    const stale = await resolvePreviewToken(token);
    expect(stale.issuer_active).toBe(false);
    expect(stale.content_entry_versions.data_jsonb).toEqual({});
  });

  it("saves, lists and deletes saved entry views per user", async () => {
    const { workspaceId, adminUserId, modelId } = await setup(backend);
    const created = await createSavedEntryView({ workspaceId, actorAdminUserId: adminUserId, name: " Drafts ", filters: { modelId, status: "draft", query: "  hello ", sort: "updated_asc", junk: 1 } });
    if (!created.ok) throw new Error(created.error);
    expect(created.data).toMatchObject({ name: "Drafts", content_model_id: modelId, filters_json: { modelId, status: "draft", query: "hello", sort: "updated_asc" } });
    expect(await createSavedEntryView({ workspaceId, actorAdminUserId: adminUserId, name: "", filters: {} })).toMatchObject({ ok: false, status: 400 });
    expect((await listSavedEntryViews(workspaceId, adminUserId)).map((v) => v.id)).toEqual([created.data.id]);
    const other = await backend.createWorkspace();
    expect(await listSavedEntryViews(other.workspaceId, adminUserId)).toEqual([]);
    expect(await deleteSavedEntryView({ workspaceId: other.workspaceId, actorAdminUserId: other.adminUserId, viewId: created.data.id })).toMatchObject({ ok: false, status: 404 });
    // Another user in the same workspace cannot delete it either.
    const [colleague] = await backend.query<{ id: string }>("insert into admin_users (username, email) values ($1, $2) returning id", [`colleague-${created.data.id.slice(0, 8)}`, `colleague-${created.data.id.slice(0, 8)}@example.test`]);
    expect(await deleteSavedEntryView({ workspaceId, actorAdminUserId: colleague.id, viewId: created.data.id })).toMatchObject({ ok: false, status: 404 });
    expect(await deleteSavedEntryView({ workspaceId, actorAdminUserId: adminUserId, viewId: created.data.id })).toEqual({ ok: true });
    expect(await listSavedEntryViews(workspaceId, adminUserId)).toEqual([]);
    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'content_entry_saved_view' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["content.entry_view.created", "content.entry_view.deleted"]);
  });
});
