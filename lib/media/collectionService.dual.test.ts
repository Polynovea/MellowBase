import { describe, expect, it, vi } from "vitest";
import { describeBothBackends, type BackendFixtures } from "@/lib/db/testing/dualBackend";
import { createRecorder, ISO_TIMESTAMP, jsonRequest, LEAKED_DB_ERROR, readJson, routeParams } from "@/lib/db/testing/compare";
import {
  addAssetToCollection,
  createCollection,
  deleteCollection,
  getCollection,
  listCollectionAssets,
  listCollections,
  removeAssetFromCollection,
  updateCollection,
} from "@/lib/media/collectionService";
import { GET as listHandler, POST as createHandler } from "@/app/api/media/collections/route";
import { DELETE as deleteHandler, GET as getHandler, PUT as updateHandler } from "@/app/api/media/collections/[id]/route";

const actor = vi.hoisted(() => ({ workspaceId: "", adminUserId: "" }));
vi.mock("@/lib/platform/permissions", () => ({
  requirePlatformAccess: vi.fn(async () => ({ data: { actor: { ...actor }, adminUser: { id: actor.adminUserId } } })),
}));

const COLLECTION_KEYS = ["created_at", "created_by", "description", "id", "name", "parent_collection_id", "slug", "updated_at", "workspace_id"];
const recorder = createRecorder();

async function asset(backend: BackendFixtures, workspaceId: string, name: string) {
  const [row] = await backend.query<{ id: string }>(
    "insert into assets (workspace_id, storage_provider, storage_key, filename, mime_type, size_bytes, checksum) values ($1, 'test', $2, $3, 'image/png', 10, $4) returning id",
    [workspaceId, `${workspaceId}/${name}`, name, `sum-${name}-${workspaceId}`],
  );
  return row.id;
}

describeBothBackends("media", "media collection service", (backend) => {
  it("creates, nests, counts, updates and deletes collections with identical shapes", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    const root = await createCollection({ workspaceId, actorAdminUserId: adminUserId, name: " Brand ", slug: "Brand Kit!", description: " Logos " });
    expect(Object.keys(root).sort()).toEqual(COLLECTION_KEYS);
    expect(root).toMatchObject({ name: "Brand", slug: "brand-kit-", description: "Logos", parent_collection_id: null, created_by: adminUserId });
    expect(root.created_at).toMatch(ISO_TIMESTAMP);
    const child = await createCollection({ workspaceId, actorAdminUserId: adminUserId, name: "Icons", slug: "icons", parentCollectionId: root.id });
    const a = await asset(backend, workspaceId, "a.png");
    const b = await asset(backend, workspaceId, "b.png");
    await addAssetToCollection({ workspaceId, collectionId: child.id, assetId: b, position: 1 });
    await addAssetToCollection({ workspaceId, collectionId: child.id, assetId: a, position: 0 });
    await addAssetToCollection({ workspaceId, collectionId: child.id, assetId: a, position: 5 }); // upsert moves it

    const tree = await listCollections(workspaceId);
    expect(tree.map((c) => [c.name, c.assetCount])).toEqual([["Brand", 0]]);
    expect(tree[0].children?.map((c) => [c.name, c.assetCount])).toEqual([["Icons", 2]]);
    expect((await listCollectionAssets(workspaceId, child.id)).map((x) => x.id)).toEqual([b, a]);

    const updated = await updateCollection({ workspaceId, actorAdminUserId: adminUserId, id: child.id, name: "Glyphs", description: null });
    expect(updated).toMatchObject({ name: "Glyphs", description: null, parent_collection_id: root.id });
    await removeAssetFromCollection({ workspaceId, collectionId: child.id, assetId: b });
    expect((await listCollectionAssets(workspaceId, child.id)).map((x) => x.id)).toEqual([a]);
    expect(await getCollection(workspaceId, "not-a-uuid")).toBeNull();
    expect(await listCollectionAssets(workspaceId, "not-a-uuid")).toEqual([]);

    expect(await deleteCollection({ workspaceId, actorAdminUserId: adminUserId, id: root.id })).toEqual({ ok: true });
    expect(await getCollection(workspaceId, child.id)).toBeNull(); // cascades to the child
    const events = await backend.query<{ action: string }>("select action from platform_audit_events where workspace_id = $1 and entity_type = 'media_collection' order by action", [workspaceId]);
    expect(events.map((e) => e.action)).toEqual(["media.collection.created", "media.collection.created", "media.collection.deleted", "media.collection.updated"]);

    recorder.record(backend.name, "collections", { root, child, tree, updated });
  });

  it("rejects a duplicate slug and keeps workspaces isolated", async () => {
    const a = await backend.createWorkspace();
    const b = await backend.createWorkspace();
    const collection = await createCollection({ workspaceId: a.workspaceId, actorAdminUserId: a.adminUserId, name: "Mine", slug: "mine" });
    await expect(createCollection({ workspaceId: a.workspaceId, actorAdminUserId: a.adminUserId, name: "Again", slug: "mine" })).rejects.toThrow();
    const assetA = await asset(backend, a.workspaceId, "x.png");
    const assetB = await asset(backend, b.workspaceId, "y.png");

    expect(await listCollections(b.workspaceId)).toEqual([]);
    expect(await getCollection(b.workspaceId, collection.id)).toBeNull();
    expect(await listCollectionAssets(b.workspaceId, collection.id)).toEqual([]);
    await expect(updateCollection({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, id: collection.id, name: "Stolen" })).rejects.toThrow();
    // Another workspace's asset, or a collection of another workspace, cannot be linked (composite keys).
    await expect(addAssetToCollection({ workspaceId: a.workspaceId, collectionId: collection.id, assetId: assetB })).rejects.toThrow();
    await expect(addAssetToCollection({ workspaceId: b.workspaceId, collectionId: collection.id, assetId: assetA })).rejects.toThrow();
    await deleteCollection({ workspaceId: b.workspaceId, actorAdminUserId: b.adminUserId, id: collection.id });
    expect((await getCollection(a.workspaceId, collection.id))?.name).toBe("Mine");
  });

  it("serves the collection routes end to end without leaking database errors", async () => {
    const { workspaceId, adminUserId } = await backend.createWorkspace();
    actor.workspaceId = workspaceId;
    actor.adminUserId = adminUserId;
    const created = await readJson(await createHandler(jsonRequest({ name: "Route", slug: "route" })));
    expect(created.status).toBeLessThan(300);
    const id = created.body.data.id as string;
    const assetId = await asset(backend, workspaceId, "r.png");
    expect((await readJson(await listHandler(jsonRequest(undefined, "http://cms.test/api/media/collections")))).body.data).toHaveLength(1);
    expect((await readJson(await updateHandler(jsonRequest({ action: "add_asset", assetId }, "http://cms.test/x", "PUT"), routeParams({ id })))).status).toBe(200);
    const detail = await readJson(await getHandler(jsonRequest(), routeParams({ id })));
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body.data)).toContain(assetId);
    expect(await readJson(await getHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })))).toMatchObject({ status: 404 });
    for (const response of [
      await createHandler(jsonRequest({ name: "Dup", slug: "route" })),
      await updateHandler(jsonRequest({ action: "add_asset", assetId: "not-a-uuid" }, "http://cms.test/x", "PUT"), routeParams({ id })),
      await deleteHandler(jsonRequest(), routeParams({ id: "not-a-uuid" })),
    ]) {
      const { status, body } = await readJson(response);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(body.error).not.toMatch(LEAKED_DB_ERROR);
    }
    expect((await readJson(await deleteHandler(jsonRequest(), routeParams({ id })))).status).toBe(200);
  });
});

describe("media collection backends agree", () => {
  it("returns identical shapes and values on supabase and postgres", () => recorder.expectAgreement());
});
