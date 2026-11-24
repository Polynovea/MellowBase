// Content area, search: the shared text extraction and search parameters.
import * as postgres from "@/lib/content/searchService.postgres";

export function searchableText(data: Record<string, unknown>) {
  const title = typeof data.title === "string" ? [data.title] : [];
  return [...title, ...Object.entries(data)
    .filter(([key]) => key !== "title")
    .flatMap(([, value]) => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])]
    .join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Field permissions for search (phase 4, the items API's permission function): models where the
 * caller cannot read every field, by model id, with the field keys it can read. Such a model matches
 * only on its readable search-indexed columns, is never ranked by its whole-document text, and its
 * rows carry no search_text. `readableModelIds`: every model the caller can read.
 */
export interface SearchFieldScope {
  restricted: ReadonlyMap<string, ReadonlySet<string>>;
  readableModelIds: readonly string[];
  /** Readable field keys of every readable model: snippets are rebuilt from these only. */
  readable: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ContentSearchParams {
  fieldScope?: SearchFieldScope;
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


export const indexEntry = postgres.indexEntry;
export const searchContent = postgres.searchContent;
export const listSavedSearches = postgres.listSavedSearches;
export const saveSearch = postgres.saveSearch;
export const deleteSavedSearch = postgres.deleteSavedSearch;
