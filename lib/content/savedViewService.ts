// Content area, saved entry views: types, filter normalization and the backend dispatcher.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/savedViewService.postgres";
import * as supabase from "@/lib/content/savedViewService.supabase";

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

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const listSavedEntryViews: typeof supabase.listSavedEntryViews = (...args) => impl().listSavedEntryViews(...args);
export const createSavedEntryView: typeof supabase.createSavedEntryView = (...args) => impl().createSavedEntryView(...args);
export const deleteSavedEntryView: typeof supabase.deleteSavedEntryView = (...args) => impl().deleteSavedEntryView(...args);
