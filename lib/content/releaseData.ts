// Content area, releases and the editorial calendar: database primitives. releaseService.ts and
// calendarService.ts keep their readiness, scheduling and calendar rules and call these, so both
// paths apply the same rules.
import * as postgres from "@/lib/content/releaseData.postgres";

export type ReleaseFunctionName =
  | "cms_create_release"
  | "cms_replace_release_items"
  | "cms_set_release_locales"
  | "cms_assign_release"
  | "cms_transition_release"
  | "cms_publish_release";

/** The function's jsonb result, or its SQLSTATE and a message that is safe to show. */
export type ReleaseFunctionResult = { ok: true; data: unknown } | { ok: false; code: string | null; message: string | null };


export const listReleases = postgres.listReleases;
export const getRelease = postgres.getRelease;
export const requiredLocales = postgres.requiredLocales;
export const translationsOfSources = postgres.translationsOfSources;
export const entryRelationsFrom = postgres.entryRelationsFrom;
export const entryStatusesById = postgres.entryStatusesById;
export const dueReleases = postgres.dueReleases;
export const callReleaseFunction = postgres.callReleaseFunction;
export const listCalendarEvents = postgres.listCalendarEvents;
export const releaseExists = postgres.releaseExists;
export const insertCalendarEvent = postgres.insertCalendarEvent;
