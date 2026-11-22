// Media area, collections: types, the shared tree builder, and the backend dispatcher.
//
// Each function runs on Supabase (collectionService.supabase.ts) or directly on PostgreSQL
// (collectionService.postgres.ts), chosen per call by the `media` switch in POLYNOVEA_DATA_BACKEND.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/media/collectionService.postgres";
import * as supabase from "@/lib/media/collectionService.supabase";

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

/** Nests collections under their parents and attaches each one's asset count (shared by both paths). */
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

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("media") ? direct : supabase);

export const listCollections: typeof supabase.listCollections = (...args) => impl().listCollections(...args);
export const getCollection: typeof supabase.getCollection = (...args) => impl().getCollection(...args);
export const createCollection: typeof supabase.createCollection = (...args) => impl().createCollection(...args);
export const updateCollection: typeof supabase.updateCollection = (...args) => impl().updateCollection(...args);
export const deleteCollection: typeof supabase.deleteCollection = (...args) => impl().deleteCollection(...args);
export const addAssetToCollection: typeof supabase.addAssetToCollection = (...args) => impl().addAssetToCollection(...args);
export const removeAssetFromCollection: typeof supabase.removeAssetFromCollection = (...args) => impl().removeAssetFromCollection(...args);
export const listCollectionAssets: typeof supabase.listCollectionAssets = (...args) => impl().listCollectionAssets(...args);
