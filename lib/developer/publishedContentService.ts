// Published-content delivery API (GET /api/v1/content): types, the shared ordering rule.
import * as postgres from "@/lib/developer/publishedContentService.postgres";

export interface PublishedContentRecord {
  id: string;
  model: string;
  locale: string;
  versionId: string;
  version: number;
  publishedAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
  route: { path: string; locale: string } | null;
}

/**
 * Records in the order of the page of entries (most recently updated first). The versions query
 * returns rows in no particular order, and the Supabase path used to return records in that order.
 */
export function orderLikeEntries(records: PublishedContentRecord[], entries: { id: string }[]): PublishedContentRecord[] {
  const position = new Map(entries.map((entry, index) => [entry.id, index]));
  return [...records].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}


export const listPublishedContent = postgres.listPublishedContent;
export const getPublishedContent = postgres.getPublishedContent;
