// Supabase path of the media area's collection service (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import type { AssetRow } from "@/lib/media/assetService";
import { buildCollectionTree, type MediaCollectionRow } from "@/lib/media/collectionService";

export async function listCollections(workspaceId: string): Promise<MediaCollectionRow[]> {
  const db = createServiceRoleClient();
  const [colsRes, countRes] = await Promise.all([
    db.from("media_collections").select("*").eq("workspace_id", workspaceId).order("name", { ascending: true }),
    db.from("media_collection_assets").select("collection_id").eq("workspace_id", workspaceId),
  ]);

  const collections = (colsRes.data as MediaCollectionRow[]) ?? [];
  return buildCollectionTree(collections, (countRes.data ?? []).map((row: { collection_id: string }) => row.collection_id));
}

export async function getCollection(workspaceId: string, id: string): Promise<MediaCollectionRow | null> {
  const { data } = await createServiceRoleClient()
    .from("media_collections")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  return (data as MediaCollectionRow) ?? null;
}

export async function createCollection(params: {
  workspaceId: string;
  actorAdminUserId: string;
  name: string;
  slug: string;
  description?: string | null;
  parentCollectionId?: string | null;
}): Promise<MediaCollectionRow> {
  const db = createServiceRoleClient();
  const slug = params.slug.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-");

  const { data, error } = await db
    .from("media_collections")
    .insert({
      workspace_id: params.workspaceId,
      name: params.name.trim(),
      slug,
      description: params.description?.trim() || null,
      parent_collection_id: params.parentCollectionId || null,
      created_by: params.actorAdminUserId,
    })
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || "Could not create media collection");

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "media.collection.created",
    entityType: "media_collection",
    entityId: data.id,
    metadata: { name: data.name, slug: data.slug },
  });

  return data as MediaCollectionRow;
}

export async function updateCollection(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
  name?: string;
  description?: string | null;
  parentCollectionId?: string | null;
}): Promise<MediaCollectionRow> {
  const db = createServiceRoleClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (params.name !== undefined) updates.name = params.name.trim();
  if (params.description !== undefined) updates.description = params.description?.trim() || null;
  if (params.parentCollectionId !== undefined) updates.parent_collection_id = params.parentCollectionId;

  const { data, error } = await db
    .from("media_collections")
    .update(updates)
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.id)
    .select()
    .single();

  if (error || !data) throw new Error(error?.message || "Could not update media collection");

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "media.collection.updated",
    entityType: "media_collection",
    entityId: data.id,
    metadata: updates,
  });

  return data as MediaCollectionRow;
}

export async function deleteCollection(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
}): Promise<{ ok: true }> {
  const db = createServiceRoleClient();
  const { error } = await db
    .from("media_collections")
    .delete()
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.id);

  if (error) throw new Error(error.message);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "media.collection.deleted",
    entityType: "media_collection",
    entityId: params.id,
    metadata: {},
  });

  return { ok: true };
}

export async function addAssetToCollection(params: {
  workspaceId: string;
  collectionId: string;
  assetId: string;
  position?: number;
}): Promise<{ ok: true }> {
  const db = createServiceRoleClient();
  const { error } = await db.from("media_collection_assets").upsert(
    {
      workspace_id: params.workspaceId,
      collection_id: params.collectionId,
      asset_id: params.assetId,
      position: params.position ?? 0,
    },
    { onConflict: "collection_id,asset_id" }
  );

  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function removeAssetFromCollection(params: {
  workspaceId: string;
  collectionId: string;
  assetId: string;
}): Promise<{ ok: true }> {
  const db = createServiceRoleClient();
  const { error } = await db
    .from("media_collection_assets")
    .delete()
    .eq("workspace_id", params.workspaceId)
    .eq("collection_id", params.collectionId)
    .eq("asset_id", params.assetId);

  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function listCollectionAssets(workspaceId: string, collectionId: string): Promise<AssetRow[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("media_collection_assets")
    .select("assets(*)")
    .eq("workspace_id", workspaceId)
    .eq("collection_id", collectionId)
    .order("position", { ascending: true });

  return (data ?? []).map((row: any) => row.assets).filter(Boolean);
}
