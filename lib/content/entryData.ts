// Content area, entries and versions: database primitives. entryService.ts keeps every rule (schema
// validation, uniqueness, relation integrity, lifecycle checks) and calls these.
import * as postgres from "@/lib/content/entryData.postgres";

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


export const currentVersionsOfModel = postgres.currentVersionsOfModel;
export const entriesWithModelKeys = postgres.entriesWithModelKeys;
export const assetsById = postgres.assetsById;
export const liveRouteIdsByPath = postgres.liveRouteIdsByPath;
export const listEntries = postgres.listEntries;
export const getEntry = postgres.getEntry;
export const listEntryVersions = postgres.listEntryVersions;
export const findEntryVersion = postgres.findEntryVersion;
export const versionDataByIds = postgres.versionDataByIds;
export const callEntryFunction = postgres.callEntryFunction;
