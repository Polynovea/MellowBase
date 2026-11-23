import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeWithDatabase } from "@/lib/db/testing/database";

const routeData = await import("@/lib/http/routeData");
const SHA = "a".repeat(64);

describeWithDatabase("queries made directly in API routes", (backend) => {
  it("creates, lists, updates and deletes platforms", async () => {
    const name = `Platform ${randomUUID().slice(0, 8)}`;
    const created = await routeData.createPlatform({ name, for_social: false, for_ads: true });
    const second = await routeData.createPlatform({ name: `${name} 2`, for_social: true, for_ads: false });
    expect(created).toMatchObject({ name, for_social: false, for_ads: true, is_active: true });
    expect(second.sort_order).toBe(created.sort_order + 1);
    expect((await routeData.listPlatforms("ads")).map((p) => p.id)).toContain(created.id);
    expect((await routeData.listPlatforms("social")).map((p) => p.id)).not.toContain(created.id);

    const updated = await routeData.updatePlatform(created.id, { is_active: false });
    expect(updated).toMatchObject({ id: created.id, is_active: false });
    expect((await routeData.listPlatforms("ads")).map((p) => p.id)).not.toContain(created.id);
    expect(await routeData.updatePlatform(randomUUID(), { is_active: false })).toBeNull();

    await routeData.deletePlatform(created.id);
    await routeData.deletePlatform(second.id);
    expect((await routeData.listPlatforms(null)).map((p) => p.id)).not.toContain(created.id);
  });

  it("reads entries, search documents, members and assets only inside the workspace", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const { entryId, versionIds } = await backend.createEntry(workspaceId, 1);
    const [{ content_model_id: modelId }] = await backend.query<{ content_model_id: string }>("select content_model_id from content_entries where id = $1", [entryId]);
    await backend.query("insert into content_search_documents (entry_id, workspace_id, version_id, content_model_id, locale, status, search_text) values ($1, $2, $3, $4, 'en', 'published', 'hello')", [entryId, workspaceId, versionIds[0], modelId]);
    await backend.query("insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active')", [workspaceId, adminUserId]);
    await backend.query("insert into assets (workspace_id, storage_provider, storage_key, filename, mime_type, size_bytes, checksum) values ($1, 'local', $2, 'a.png', 'image/png', 1, 'x')", [workspaceId, `${workspaceId}/a.png`]);

    expect(await routeData.entryIdsInModels(workspaceId, [modelId, randomUUID()])).toEqual([entryId]);
    expect(await routeData.searchDocuments(workspaceId, [entryId])).toEqual([{ entry_id: entryId, search_text: "hello", status: "published", locale: "en" }]);
    expect((await routeData.activeMemberProfiles(workspaceId)).map((m) => m.id)).toEqual([adminUserId]);
    expect(await routeData.storageKeyRegistered(workspaceId, `${workspaceId}/a.png`)).toBe(true);
    expect(await routeData.versionModelKeys(workspaceId, versionIds)).toEqual([{ id: versionIds[0], apiKey: expect.any(String) }]);
    expect(await routeData.entryModelKeys(workspaceId, [entryId])).toEqual([{ id: entryId, apiKey: expect.any(String) }]);

    const other = await backend.createWorkspace();
    expect(await routeData.entryIdsInModels(other.workspaceId, [modelId])).toEqual([]);
    expect(await routeData.searchDocuments(other.workspaceId, [entryId])).toEqual([]);
    expect(await routeData.activeMemberProfiles(other.workspaceId)).toEqual([]);
    expect(await routeData.storageKeyRegistered(other.workspaceId, `${workspaceId}/a.png`)).toBe(false);
    expect(await routeData.versionModelKeys(other.workspaceId, versionIds)).toEqual([]);
    expect(await routeData.entryModelKeys(other.workspaceId, [entryId])).toEqual([]);
    expect(await routeData.entryIdsInModels(workspaceId, [])).toEqual([]);
  });

  it("lists extension installations with their manifests, and import and schema runs", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const [manifest] = await backend.query<{ id: string }>("insert into extension_manifests (workspace_id, extension_key, name, version, manifest_json, manifest_sha256, publisher) values ($1, 'ext', 'Ext', '1.0.0', '{}'::jsonb, $2, 'Acme') returning id", [workspaceId, SHA]);
    const [installation] = await backend.query<{ id: string }>("insert into extension_installations (workspace_id, manifest_id, installed_by) values ($1, $2, $3) returning id", [workspaceId, manifest.id, adminUserId]);
    const { entryId } = await backend.createEntry(workspaceId, 1);
    const [{ content_model_id: modelId }] = await backend.query<{ content_model_id: string }>("select content_model_id from content_entries where id = $1", [entryId]);
    await backend.query("insert into developer_import_runs (workspace_id, content_model_id, format, mode, status) values ($1, $2, 'json', 'dry_run', 'planned')", [workspaceId, modelId]);
    await backend.query("insert into developer_schema_runs (workspace_id, operation, status, bundle_hash) values ($1, 'dry_run', 'planned', $2)", [workspaceId, SHA]);

    const installations = await routeData.extensionInstallations(workspaceId);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({ id: installation.id, manifest_id: manifest.id, extension_manifests: { extension_key: "ext", name: "Ext", version: "1.0.0", publisher: "Acme", manifest_sha256: SHA } });
    expect(await routeData.importRuns(workspaceId)).toHaveLength(1);
    expect(await routeData.schemaRuns(workspaceId)).toHaveLength(1);

    const other = await backend.createWorkspace();
    expect(await routeData.extensionInstallations(other.workspaceId)).toEqual([]);
    expect(await routeData.importRuns(other.workspaceId)).toEqual([]);
    expect(await routeData.schemaRuns(other.workspaceId)).toEqual([]);
  });
});
