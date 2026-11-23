// Content area, search: the shared text extraction and search parameters, and the backend dispatcher
// (the `content` switch in POLYNOVEA_DATA_BACKEND).
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/searchService.postgres";
import * as supabase from "@/lib/content/searchService.supabase";

export function searchableText(data: Record<string, unknown>) {
  const title = typeof data.title === "string" ? [data.title] : [];
  return [...title, ...Object.entries(data)
    .filter(([key]) => key !== "title")
    .flatMap(([, value]) => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])]
    .join(" ").replace(/\s+/g, " ").trim();
}

export interface ContentSearchParams {
  workspaceId: string;
  query?: string;
  modelId?: string;
  status?: string;
  locale?: string;
  authorId?: string;
  updatedFrom?: string;
  updatedTo?: string;
  termId?: string;
  sort?: "relevance" | "updated_desc" | "updated_asc";
  limit?: number;
  offset?: number;
}

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const indexEntry: typeof supabase.indexEntry = (...args) => impl().indexEntry(...args);
export const searchContent: typeof supabase.searchContent = (...args) => impl().searchContent(...args);
export const listSavedSearches: typeof supabase.listSavedSearches = (...args) => impl().listSavedSearches(...args);
export const saveSearch: typeof supabase.saveSearch = (...args) => impl().saveSearch(...args);
export const deleteSavedSearch: typeof supabase.deleteSavedSearch = (...args) => impl().deleteSavedSearch(...args);
