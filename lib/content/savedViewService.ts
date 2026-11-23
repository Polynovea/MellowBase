// Content area, saved entry views: types, filter normalization.
import * as postgres from "@/lib/content/savedViewService.postgres";

export interface SavedEntryViewFilters {
  modelId?: string;
  status?: string;
  query?: string;
  sort?: "updated_desc" | "updated_asc";
}

export interface SavedEntryView {
  id: string;
  workspace_id: string;
  content_model_id: string | null;
  name: string;
  filters_json: SavedEntryViewFilters;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function normalizeFilters(value: unknown): SavedEntryViewFilters {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: SavedEntryViewFilters = {};
  if (typeof raw.modelId === "string" && raw.modelId) result.modelId = raw.modelId;
  if (typeof raw.status === "string" && raw.status) result.status = raw.status;
  if (typeof raw.query === "string" && raw.query.trim()) result.query = raw.query.trim().slice(0, 200);
  if (raw.sort === "updated_asc" || raw.sort === "updated_desc") result.sort = raw.sort;
  return result;
}


export const listSavedEntryViews = postgres.listSavedEntryViews;
export const createSavedEntryView = postgres.createSavedEntryView;
export const deleteSavedEntryView = postgres.deleteSavedEntryView;
