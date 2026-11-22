// Direct PostgreSQL implementation of the media area's collection service (phase 1, wave 2).
//
// Same signatures and return shapes as collectionService.supabase.ts. Differences that are deliberate:
// - Create, update and delete commit with their audit rows in one transaction.
// - Asset counts are counted in SQL (the Supabase path loaded one row per collection membership and
//   counted in memory, capped at 1000 by PostgREST).
// - Malformed IDs in reads are "not found"; explicit limits; every statement scoped by workspace_id.
// The composite foreign keys on media_collection_assets ((collection_id, workspace_id) and
// (asset_id, workspace_id)) keep a collection and its assets in one workspace on both paths.
import { DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { AssetRow } from "@/lib/media/assetService";
import { buildCollectionTree, type MediaCollectionRow } from "@/lib/media/collectionService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);
const asCollection = (row: unknown) => row as MediaCollectionRow;

export async function listCollections(workspaceId: string): Promise<MediaCollectionRow[]> {
  const db = getDb();
  const [collections, counts] = await Promise.all([
    db.selectFrom("media_collections").selectAll().where("workspace_id", "=", workspaceId)
      .orderBy("name", "asc").orderBy("id", "asc").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("media_collection_assets").select(["collection_id", (eb) => eb.fn.countAll<number>().as("count")])
      .where("workspace_id", "=", workspaceId).groupBy("collection_id").execute(),
  ]);
  // The shared builder counts one entry per membership; expand the grouped counts to that form.
  const memberships = counts.flatMap((row) => Array.from({ length: Number(row.count) }, () => row.collection_id));
  return buildCollectionTree(collections.map(asCollection), memberships);
}

export async function getCollection(workspaceId: string, id: string): Promise<MediaCollectionRow | null> {
  if (!isUuid(id)) return null;
  const row = maybeOne(await getDb().selectFrom("media_collections").selectAll()
    .where("workspace_id", "=", workspaceId).where("id", "=", id).execute());
  return row ? asCollection(row) : null;
}

export async function createCollection(params: {
  workspaceId: string;
  actorAdminUserId: string;
  name: string;
  slug: string;
  description?: string | null;
  parentCollectionId?: string | null;
}): Promise<MediaCollectionRow> {
  const slug = params.slug.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-");
  return withTransaction(async (trx) => {
    const data = asCollection(expectOne(await trx.insertInto("media_collections").values({
      workspace_id: params.workspaceId,
      name: params.name.trim(),
      slug,
      description: params.description?.trim() || null,
      parent_collection_id: params.parentCollectionId || null,
      created_by: params.actorAdminUserId,
    }).returningAll().execute(), "Could not create media collection"));

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "media.collection.created",
      entityType: "media_collection",
      entityId: data.id,
      metadata: { name: data.name, slug: data.slug },
    });
    return data;
  });
}

export async function updateCollection(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
  name?: string;
  description?: string | null;
  parentCollectionId?: string | null;
}): Promise<MediaCollectionRow> {
  const updates: { updated_at: string; name?: string; description?: string | null; parent_collection_id?: string | null } = { updated_at: new Date().toISOString() };
  if (params.name !== undefined) updates.name = params.name.trim();
  if (params.description !== undefined) updates.description = params.description?.trim() || null;
  if (params.parentCollectionId !== undefined) updates.parent_collection_id = params.parentCollectionId;
  if (!isUuid(params.id)) throw new Error("Could not update media collection");

  return withTransaction(async (trx) => {
    const data = asCollection(expectOne(await trx.updateTable("media_collections").set(updates)
      .where("workspace_id", "=", params.workspaceId).where("id", "=", params.id)
      .returningAll().execute(), "Could not update media collection"));

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "media.collection.updated",
      entityType: "media_collection",
      entityId: data.id,
      metadata: updates,
    });
    return data;
  });
}

export async function deleteCollection(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
}): Promise<{ ok: true }> {
  if (!isUuid(params.id)) throw new Error("Invalid media collection ID");
  await withTransaction(async (trx) => {
    await trx.deleteFrom("media_collections").where("workspace_id", "=", params.workspaceId).where("id", "=", params.id).execute();
    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "media.collection.deleted",
      entityType: "media_collection",
      entityId: params.id,
      metadata: {},
    });
  });
  return { ok: true };
}

export async function addAssetToCollection(params: {
  workspaceId: string;
  collectionId: string;
  assetId: string;
  position?: number;
}): Promise<{ ok: true }> {
  if (!isUuid(params.collectionId) || !isUuid(params.assetId)) throw new Error("Invalid collection or asset ID");
  await getDb().insertInto("media_collection_assets").values({
    workspace_id: params.workspaceId,
    collection_id: params.collectionId,
    asset_id: params.assetId,
    position: params.position ?? 0,
  })
    // Same as the Supabase upsert on (collection_id, asset_id): every column it sent.
    .onConflict((conflict) => conflict.columns(["collection_id", "asset_id"]).doUpdateSet((eb) => ({
      workspace_id: eb.ref("excluded.workspace_id"),
      position: eb.ref("excluded.position"),
    })))
    .execute();
  return { ok: true };
}

export async function removeAssetFromCollection(params: {
  workspaceId: string;
  collectionId: string;
  assetId: string;
}): Promise<{ ok: true }> {
  if (!isUuid(params.collectionId) || !isUuid(params.assetId)) throw new Error("Invalid collection or asset ID");
  await getDb().deleteFrom("media_collection_assets")
    .where("workspace_id", "=", params.workspaceId)
    .where("collection_id", "=", params.collectionId)
    .where("asset_id", "=", params.assetId)
    .execute();
  return { ok: true };
}

export async function listCollectionAssets(workspaceId: string, collectionId: string): Promise<AssetRow[]> {
  if (!isUuid(collectionId)) return [];
  const rows = await getDb()
    .selectFrom("media_collection_assets as ca")
    .innerJoin("assets as a", (join) => join.onRef("a.id", "=", "ca.asset_id").onRef("a.workspace_id", "=", "ca.workspace_id"))
    .selectAll("a")
    .where("ca.workspace_id", "=", workspaceId)
    .where("ca.collection_id", "=", collectionId)
    .orderBy("ca.position", "asc")
    .orderBy("a.id", "asc")
    .limit(DEFAULT_LIST_LIMIT)
    .execute();
  return rows as unknown as AssetRow[];
}
