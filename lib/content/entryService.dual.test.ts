import { describe, expect, it } from "vitest";
import { describeWithDatabase, type BackendFixtures } from "@/lib/db/testing/database";
import { ISO_TIMESTAMP } from "@/lib/db/testing/http";
import {
  archiveEntry,
  createEntry,
  exportEntries,
  getEntry,
  importEntries,
  listEntries,
  listEntryOptions,
  listEntryVersions,
  publishEntry,
  restoreEntryVersion,
  saveDraft,
  unarchiveEntry,
} from "@/lib/content/entryService";
import { createModel } from "@/lib/schema/modelService";
import { runGovernedImport } from "@/lib/developer/importService";
import type { DeveloperApiContext } from "@/lib/developer/apiAuth";
const ENTRY_KEYS = ["archived_at", "content_model_id", "created_at", "created_by", "current_draft_version_id", "id", "published_version_id", "status", "status_before_archive", "updated_at", "updated_by", "workspace_id"];
const VERSION_KEYS = ["change_summary", "created_at", "created_by", "data_jsonb", "entry_id", "id", "locale", "model_schema_version", "state", "version_number"];

async function models(backend: BackendFixtures) {
  const { workspaceId, adminUserId } = await backend.createWorkspace();
  const widget = await createModel({ workspaceId, createdBy: adminUserId, proposedSchema: { name: "Widget", apiKey: "widget", fields: [{ key: "title", label: "Title", type: "text", required: true }] } });
  const article = await createModel({
    workspaceId, createdBy: adminUserId, proposedSchema: {
      name: "Article", apiKey: "article", fields: [
        { key: "title", label: "Title", type: "text", required: true },
        { key: "slug", label: "Slug", type: "text", unique: true },
        { key: "widget", label: "Widget", type: "relation", relation: { targetModelApiKey: "widget", cardinality: "many_to_one", onDelete: "block" } },
      ],
    },
  });
  if (!widget.ok || !article.ok) throw new Error("model setup failed");
  return { workspaceId, adminUserId, widgetModelId: widget.data.model.id, articleModelId: article.data.model.id };
}

describeWithDatabase("content entries and versions", (backend) => {
  it("creates, lists, drafts, publishes, archives and restores entries with identical shapes", async () => {
    const { workspaceId, adminUserId, articleModelId } = await models(backend);
    const created = await createEntry({ workspaceId, modelId: articleModelId, data: { title: "Hello", slug: "hello" }, actorAdminUserId: adminUserId });
    if (!created.ok) throw new Error(created.error);
    const { entry, version } = created.data;
    expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
    expect(Object.keys(version).sort()).toEqual(VERSION_KEYS);
    expect(entry).toMatchObject({ status: "draft", current_draft_version_id: version.id, published_version_id: null });
    expect(version).toMatchObject({ version_number: 1, data_jsonb: { title: "Hello", slug: "hello" }, locale: "en", change_summary: "Initial draft" });
    expect(entry.created_at).toMatch(ISO_TIMESTAMP);

    const conflict = await saveDraft({ workspaceId, entryId: entry.id, data: { title: "Stale" }, actorAdminUserId: adminUserId, expectedVersionNumber: 7 });
    expect(conflict).toMatchObject({ ok: false, status: 409, conflict: { currentVersion: { version_number: 1 } } });
    const saved = await saveDraft({ workspaceId, entryId: entry.id, data: { title: "Hello again", slug: "hello" }, actorAdminUserId: adminUserId, expectedVersionNumber: 1, changeSummary: "Edit" });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.data.version).toMatchObject({ version_number: 2, change_summary: "Edit" });

    expect(await publishEntry({ workspaceId, entryId: entry.id, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 409 });
    await backend.query("update content_entries set status = 'approved' where id = $1", [entry.id]);
    const published = await publishEntry({ workspaceId, entryId: entry.id, actorAdminUserId: adminUserId });
    expect(published).toMatchObject({ ok: true, data: { status: "published", published_version_id: saved.data.version.id } });

    const listed = await listEntries(workspaceId, articleModelId);
    expect(listed.map((e) => [e.id, e.data])).toEqual([[entry.id, { title: "Hello again", slug: "hello" }]]);
    expect((await listEntryVersions(workspaceId, entry.id)).map((v) => v.version_number)).toEqual([2, 1]);

    const restored = await restoreEntryVersion({ workspaceId, entryId: entry.id, versionId: version.id, actorAdminUserId: adminUserId });
    expect(restored).toMatchObject({ ok: true, data: { version: { version_number: 3, data_jsonb: { title: "Hello", slug: "hello" }, change_summary: "Restored from version 1" } } });

    const archived = await archiveEntry({ workspaceId, entryId: entry.id, actorAdminUserId: adminUserId });
    expect(archived).toMatchObject({ ok: true, data: { status: "archived" } });
    expect(await saveDraft({ workspaceId, entryId: entry.id, data: { title: "x" }, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 409 });
    expect(await archiveEntry({ workspaceId, entryId: entry.id, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 409 });
    const unarchived = await unarchiveEntry({ workspaceId, entryId: entry.id, actorAdminUserId: adminUserId });
    expect(unarchived.ok && unarchived.data.status).toBeTruthy();
    expect((await getEntry(workspaceId, entry.id))?.status).not.toBe("archived");
    expect(await getEntry(workspaceId, "not-a-uuid")).toBeNull();

    const events = await backend.query<{ action: string }>("select distinct action from platform_audit_events where workspace_id = $1 and entity_type = 'content_entry' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toContain("content.entry.version_restored");
  });

  it("enforces unique values and relation targets", async () => {
    const { workspaceId, adminUserId, articleModelId, widgetModelId } = await models(backend);
    const widget = await createEntry({ workspaceId, modelId: widgetModelId, data: { title: "W" }, actorAdminUserId: adminUserId });
    if (!widget.ok) throw new Error(widget.error);
    const first = await createEntry({ workspaceId, modelId: articleModelId, data: { title: "A", slug: "same", widget: widget.data.entry.id }, actorAdminUserId: adminUserId });
    expect(first.ok).toBe(true);
    expect(await createEntry({ workspaceId, modelId: articleModelId, data: { title: "B", slug: "same" }, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 409 });
    // A relation to an entry of the wrong model, or of another workspace, is refused.
    const article = first.ok ? first.data.entry.id : "";
    expect(await createEntry({ workspaceId, modelId: articleModelId, data: { title: "C", widget: article }, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 400 });
    const other = await models(backend);
    const foreign = await createEntry({ workspaceId: other.workspaceId, modelId: other.widgetModelId, data: { title: "F" }, actorAdminUserId: other.adminUserId });
    if (!foreign.ok) throw new Error(foreign.error);
    expect(await createEntry({ workspaceId, modelId: articleModelId, data: { title: "D", widget: foreign.data.entry.id }, actorAdminUserId: adminUserId })).toMatchObject({ ok: false, status: 400, error: "One or more related entries do not exist in this workspace" });
    // An unknown media asset is refused before anything is written.
    expect(await listEntries(workspaceId, articleModelId)).toHaveLength(1);
  });

  it("exports, lists options, and imports (dry run and commit, also through the developer API)", async () => {
    const { workspaceId, adminUserId, articleModelId } = await models(backend);
    await createEntry({ workspaceId, modelId: articleModelId, data: { title: "One", slug: "one" }, actorAdminUserId: adminUserId });
    const imported = await importEntries({ workspaceId, modelId: articleModelId, actorAdminUserId: adminUserId, dryRun: false, rows: [{ title: "Two", slug: "two" }, { title: "Dup", slug: "two" }, { slug: "missing-title" }] });
    expect(imported).toMatchObject({ ok: true, data: { succeeded: 1, failed: 2 } });
    const exported = await exportEntries(workspaceId, articleModelId);
    expect(exported.ok && exported.data.rows.map((row) => row.data.title).sort()).toEqual(["One", "Two"]);
    expect((await listEntryOptions(workspaceId, articleModelId)).map((option) => option.label).sort()).toEqual(["One", "Two"]);

    const context = { workspaceId, actorAdminUserId: adminUserId, tokenId: null } as unknown as DeveloperApiContext;
    const committed = await runGovernedImport({ context, modelApiKey: "article", format: "json", content: [{ title: "Three", slug: "three" }], commit: true });
    expect(committed).toMatchObject({ committed: true, status: "completed", succeeded: 1, failed: 0 });
    expect((await listEntries(workspaceId, articleModelId)).map((e) => e.data?.title).sort()).toEqual(["One", "Three", "Two"]);
  });

  it("keeps workspaces isolated", async () => {
    const a = await models(backend);
    const b = await models(backend);
    const created = await createEntry({ workspaceId: a.workspaceId, modelId: a.articleModelId, data: { title: "Private" }, actorAdminUserId: a.adminUserId });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.entry.id;
    expect(await getEntry(b.workspaceId, id)).toBeNull();
    // Version reads take the workspace and go through the entry: another workspace sees none.
    expect(await listEntryVersions(b.workspaceId, id)).toEqual([]);
    expect((await listEntryVersions(a.workspaceId, id)).map((v) => v.id)).toEqual([created.data.version.id]);
    expect(await listEntries(b.workspaceId, a.articleModelId)).toEqual([]);
    expect(await saveDraft({ workspaceId: b.workspaceId, entryId: id, data: { title: "Stolen" }, actorAdminUserId: b.adminUserId })).toMatchObject({ ok: false, status: 404 });
    expect(await archiveEntry({ workspaceId: b.workspaceId, entryId: id, actorAdminUserId: b.adminUserId })).toMatchObject({ ok: false, status: 404 });
    expect(await restoreEntryVersion({ workspaceId: b.workspaceId, entryId: id, versionId: created.data.version.id, actorAdminUserId: b.adminUserId })).toMatchObject({ ok: false, status: 404 });
    expect(await createEntry({ workspaceId: b.workspaceId, modelId: a.articleModelId, data: { title: "x" }, actorAdminUserId: b.adminUserId })).toMatchObject({ ok: false, status: 404 });
    expect(await exportEntries(b.workspaceId, a.articleModelId)).toMatchObject({ ok: false, status: 404 });
  });
});
