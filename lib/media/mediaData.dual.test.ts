import { afterEach, describe, expect, it } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder } from "@/lib/db/testing/compare";
import {
  activeStorageConnections,
  defaultEnvironment,
  environmentKind,
  exactStorageConnection,
  findActiveAssetByChecksum,
  findAsset,
  findEnvironment,
  insertAsset,
  listActiveAssets,
  listAssetReplacements,
  replaceAssetFile,
} from "@/lib/media/mediaData";
import { checkWorkspaceQuota } from "@/lib/media/uploadLimits";
import type { NewAssetRow } from "@/lib/media/mediaData";

const recorder = createRecorder();

function newAsset(workspaceId: string, adminUserId: string, name: string, size = 100): NewAssetRow {
  return {
    workspace_id: workspaceId, storage_provider: "test", storage_key: `${workspaceId}/general/${name}`, filename: name,
    mime_type: "image/png", size_bytes: size, checksum: `sum-${name}`, alt_text: null, caption: "Cap", folder: "general",
    metadata_json: { storageKind: "test" }, created_by: adminUserId,
  };
}

async function environment(backend: BackendFixtures, workspaceId: string, key: string, isDefault: boolean, kind = "production") {
  const [row] = await backend.query<{ id: string }>(
    "insert into workspace_environments (workspace_id, key, name, kind, status, is_default, storage_provider) values ($1, $2, $2, $3, 'ready', $4, null) returning id",
    [workspaceId, key, kind, isDefault],
  );
  return row.id;
}

async function connection(backend: BackendFixtures, workspaceId: string, environmentId: string, name: string, lastSuccess: string | null, status = "active") {
  const [row] = await backend.query<{ id: string }>(
    `insert into workspace_connections (workspace_id, environment_id, connector_type, connector_family, name, status, active, last_success_at)
     values ($1, $2, 'storage.s3', 'storage', $3, $4, true, $5) returning id`,
    [workspaceId, environmentId, name, status, lastSuccess],
  );
  return row.id;
}

describeBothBackends("media", "media data primitives (assets, replacement, quota, storage resolution)", (backend) => {
  afterEach(() => { delete process.env.MEDIA_WORKSPACE_QUOTA_BYTES; });

  it("registers assets with their audit event, finds them by checksum and lists active ones", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const audit = (asset: { id: string }) => ({ workspaceId, actorAdminUserId: adminUserId, action: "media.asset.uploaded", entityType: "asset", entityId: asset.id, metadata: { checksum: "sum-a.png" } });
    const first = await insertAsset(newAsset(workspaceId, adminUserId, "a.png"), audit);
    if (!first.ok) throw new Error(first.error);
    expect(first.asset).toMatchObject({ filename: "a.png", size_bytes: 100, metadata_json: { storageKind: "test" }, archived_at: null });
    await insertAsset(newAsset(workspaceId, adminUserId, "b.png"), audit);
    await backend.query("update assets set archived_at = now() where workspace_id = $1 and filename = 'b.png'", [workspaceId]);

    expect((await listActiveAssets(workspaceId)).map((asset) => asset.filename)).toEqual(["a.png"]);
    expect((await findActiveAssetByChecksum(workspaceId, "sum-a.png"))?.id).toBe(first.asset.id);
    expect(await findActiveAssetByChecksum(workspaceId, "sum-b.png")).toBeNull(); // archived
    expect(await findAsset(workspaceId, "not-a-uuid")).toBeNull();
    const events = await backend.query("select entity_id from platform_audit_events where workspace_id = $1 and action = 'media.asset.uploaded'", [workspaceId]);
    expect(events).toHaveLength(2);

    // A failed insert (foreign key) returns an error result and writes no audit event.
    const failed = await insertAsset({ ...newAsset(workspaceId, adminUserId, "c.png"), created_by: "00000000-0000-0000-0000-000000000000" }, audit);
    expect(failed.ok).toBe(false);
    expect(await backend.query("select 1 from platform_audit_events where workspace_id = $1 and action = 'media.asset.uploaded'", [workspaceId])).toHaveLength(2);
    recorder.record(backend.name, "asset", first.asset);
  });

  it("replaces a file, keeps the history and refuses a foreign asset", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const inserted = await insertAsset(newAsset(workspaceId, adminUserId, "logo.png"), (asset) => ({ workspaceId, actorAdminUserId: adminUserId, action: "media.asset.uploaded", entityType: "asset", entityId: asset.id }));
    if (!inserted.ok) throw new Error(inserted.error);
    const args = {
      workspaceId, actorId: adminUserId, assetId: inserted.asset.id, storageProvider: "test", storageKey: `${workspaceId}/general/logo-v2.png`,
      checksum: "sum-logo-v2", filename: "logo-v2.png", mimeType: "image/png", sizeBytes: 250, width: 10, height: 20, reason: "Rebrand",
    };
    const replaced = await replaceAssetFile(args);
    if (!replaced.ok) throw new Error(replaced.error);
    expect(replaced.asset).toMatchObject({ id: inserted.asset.id, filename: "logo-v2.png", size_bytes: 250, checksum: "sum-logo-v2" });
    expect(replaced.replacement).toMatchObject({ asset_id: inserted.asset.id, old_filename: "logo.png", new_filename: "logo-v2.png", reason: "Rebrand", new_width: 10 });
    expect((await listAssetReplacements(workspaceId, inserted.asset.id)).map((row) => row.id)).toEqual([replaced.replacement.id]);

    const other = await backend.createWorkspace();
    const foreign = await replaceAssetFile({ ...args, workspaceId: other.workspaceId, actorId: other.adminUserId });
    expect(foreign.ok).toBe(false);
    expect(await listAssetReplacements(other.workspaceId, inserted.asset.id)).toEqual([]);
    expect((await findAsset(workspaceId, inserted.asset.id))?.filename).toBe("logo-v2.png");
    recorder.record(backend.name, "replacement", { asset: replaced.asset, replacement: replaced.replacement });
  });

  it("enforces the workspace quota from the sum of active asset sizes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    for (const [name, size] of [["q1.png", 400], ["q2.png", 500], ["q3.png", 9_000]] as const) {
      await insertAsset(newAsset(workspaceId, adminUserId, name, size), (asset) => ({ workspaceId, actorAdminUserId: adminUserId, action: "media.asset.uploaded", entityType: "asset", entityId: asset.id }));
    }
    await backend.query("update assets set archived_at = now() where workspace_id = $1 and filename = 'q3.png'", [workspaceId]);
    process.env.MEDIA_WORKSPACE_QUOTA_BYTES = "1000";
    expect(await checkWorkspaceQuota(workspaceId, 100)).toEqual({ ok: true });
    expect(await checkWorkspaceQuota(workspaceId, 101)).toMatchObject({ ok: false, status: 413 });
    const other = await backend.createWorkspace();
    expect(await checkWorkspaceQuota(other.workspaceId, 1000)).toEqual({ ok: true });
  });

  it("resolves environments and active storage connections inside one workspace", async () => {
    const { workspaceId } = await backend.createWorkspace();
    expect(await defaultEnvironment(workspaceId)).toBeNull();
    const staging = await environment(backend, workspaceId, "staging", false, "staging");
    const production = await environment(backend, workspaceId, "production", true);
    expect((await defaultEnvironment(workspaceId))?.id).toBe(production);
    expect(await findEnvironment(workspaceId, staging)).toMatchObject({ id: staging, kind: "staging", is_default: false });
    expect(await environmentKind(workspaceId, staging)).toBe("staging");

    const older = await connection(backend, workspaceId, production, "Older", "2026-01-01T00:00:00Z");
    const newer = await connection(backend, workspaceId, production, "Newer", "2026-06-01T00:00:00Z");
    const never = await connection(backend, workspaceId, production, "Never", null);
    await connection(backend, workspaceId, production, "Failing", "2026-07-01T00:00:00Z", "failed");
    await connection(backend, workspaceId, staging, "Staging", "2026-08-01T00:00:00Z");
    expect((await activeStorageConnections(workspaceId, production)).map((row) => row.id)).toEqual([newer, older, never]);
    expect(await exactStorageConnection(workspaceId, older)).toMatchObject({ id: older, connector_family: "storage" });

    const other = await backend.createWorkspace();
    expect(await findEnvironment(other.workspaceId, production)).toBeNull();
    expect(await environmentKind(other.workspaceId, production)).toBeNull();
    expect(await exactStorageConnection(other.workspaceId, older)).toBeNull();
    expect(await activeStorageConnections(other.workspaceId, production)).toEqual([]);
    expect(await exactStorageConnection(workspaceId, "not-a-uuid")).toBeNull();
  });
});

describe("media data backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
