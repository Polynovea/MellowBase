// Media area, collections: types, the shared tree builder.
//
// The queries run on PostgreSQL in collectionService.postgres.ts.
import * as postgres from "@/lib/media/collectionService.postgres";

export interface MediaCollectionRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  parent_collection_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  children?: MediaCollectionRow[];
  assetCount?: number;
}

/** Nests collections under their parents and attaches each one's asset count. */
export function buildCollectionTree(collections: MediaCollectionRow[], assetCollectionIds: string[]): MediaCollectionRow[] {
  const counts = new Map<string, number>();
  for (const id of assetCollectionIds) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const colMap = new Map<string, MediaCollectionRow>();
  for (const c of collections) {
    c.assetCount = counts.get(c.id) || 0;
    c.children = [];
    colMap.set(c.id, c);
  }

  const rootCollections: MediaCollectionRow[] = [];
  for (const c of collections) {
    if (c.parent_collection_id && colMap.has(c.parent_collection_id)) {
      colMap.get(c.parent_collection_id)!.children!.push(c);
    } else {
      rootCollections.push(c);
    }
  }

  return rootCollections;
}


export const listCollections = postgres.listCollections;
export const getCollection = postgres.getCollection;
export const createCollection = postgres.createCollection;
export const updateCollection = postgres.updateCollection;
export const deleteCollection = postgres.deleteCollection;
export const addAssetToCollection = postgres.addAssetToCollection;
export const removeAssetFromCollection = postgres.removeAssetFromCollection;
export const listCollectionAssets = postgres.listCollectionAssets;
