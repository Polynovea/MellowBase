// Content area, releases and the editorial calendar: database primitives with the backend dispatcher
// (the `content` switch in POLYNOVEA_DATA_BACKEND). releaseService.ts and calendarService.ts keep their
// readiness, scheduling and calendar rules and call these, so both paths apply the same rules.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/releaseData.postgres";
import * as supabase from "@/lib/content/releaseData.supabase";

export type ReleaseFunctionName =
  | "cms_create_release"
  | "cms_replace_release_items"
  | "cms_set_release_locales"
  | "cms_assign_release"
  | "cms_transition_release"
  | "cms_publish_release";

/** The function's jsonb result, or its SQLSTATE and a message that is safe to show. */
export type ReleaseFunctionResult = { ok: true; data: unknown } | { ok: false; code: string | null; message: string | null };

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const listReleases: typeof supabase.listReleases = (...args) => impl().listReleases(...args);
export const getRelease: typeof supabase.getRelease = (...args) => impl().getRelease(...args);
export const requiredLocales: typeof supabase.requiredLocales = (...args) => impl().requiredLocales(...args);
export const translationsOfSources: typeof supabase.translationsOfSources = (...args) => impl().translationsOfSources(...args);
export const entryRelationsFrom: typeof supabase.entryRelationsFrom = (...args) => impl().entryRelationsFrom(...args);
export const entryStatusesById: typeof supabase.entryStatusesById = (...args) => impl().entryStatusesById(...args);
export const dueReleases: typeof supabase.dueReleases = (...args) => impl().dueReleases(...args);
export const callReleaseFunction: typeof supabase.callReleaseFunction = (...args) => impl().callReleaseFunction(...args);
export const listCalendarEvents: typeof supabase.listCalendarEvents = (...args) => impl().listCalendarEvents(...args);
export const releaseExists: typeof supabase.releaseExists = (...args) => impl().releaseExists(...args);
export const insertCalendarEvent: typeof supabase.insertCalendarEvent = (...args) => impl().insertCalendarEvent(...args);
