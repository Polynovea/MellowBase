// Content area, entries and versions: database primitives with the backend dispatcher (the `content`
// switch in POLYNOVEA_DATA_BACKEND). entryService.ts keeps every rule (schema validation, uniqueness,
// relation integrity, lifecycle checks) and calls these, so both paths enforce the same rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/entryData.postgres";
import * as supabase from "@/lib/content/entryData.supabase";

export type EntryFunctionName =
  | "cms_create_content_entry"
  | "cms_save_entry_draft"
  | "cms_publish_content_entry"
  | "cms_archive_content_entry"
  | "cms_unarchive_content_entry";

/**
 * The function's jsonb result, or its error. `message` is safe to show: a message the function raised
 * itself, or (on the direct path) a generic message with a logged reference for anything else.
 */
export type EntryFunctionResult = { ok: true; data: unknown } | { ok: false; code: string | null; message: string | null };

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const currentVersionsOfModel: typeof supabase.currentVersionsOfModel = (...args) => impl().currentVersionsOfModel(...args);
export const entriesWithModelKeys: typeof supabase.entriesWithModelKeys = (...args) => impl().entriesWithModelKeys(...args);
export const assetsById: typeof supabase.assetsById = (...args) => impl().assetsById(...args);
export const liveRouteIdsByPath: typeof supabase.liveRouteIdsByPath = (...args) => impl().liveRouteIdsByPath(...args);
export const listEntries: typeof supabase.listEntries = (...args) => impl().listEntries(...args);
export const getEntry: typeof supabase.getEntry = (...args) => impl().getEntry(...args);
export const listEntryVersions: typeof supabase.listEntryVersions = (...args) => impl().listEntryVersions(...args);
export const findEntryVersion: typeof supabase.findEntryVersion = (...args) => impl().findEntryVersion(...args);
export const versionDataByIds: typeof supabase.versionDataByIds = (...args) => impl().versionDataByIds(...args);
export const callEntryFunction: typeof supabase.callEntryFunction = (...args) => impl().callEntryFunction(...args);
