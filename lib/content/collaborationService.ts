// Content area, collaboration (assignments, comments, mentions, watchers, the editorial queue) with
// the backend dispatcher (the `content` switch in POLYNOVEA_DATA_BACKEND).
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/collaborationService.postgres";
import * as supabase from "@/lib/content/collaborationService.supabase";

export type CollaborationResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const getEntryCollaboration: typeof supabase.getEntryCollaboration = (...args) => impl().getEntryCollaboration(...args);
export const assignEntry: typeof supabase.assignEntry = (...args) => impl().assignEntry(...args);
export const addComment: typeof supabase.addComment = (...args) => impl().addComment(...args);
export const setWatch: typeof supabase.setWatch = (...args) => impl().setWatch(...args);
export const resolveComment: typeof supabase.resolveComment = (...args) => impl().resolveComment(...args);
export const getMyEditorialQueue: typeof supabase.getMyEditorialQueue = (...args) => impl().getMyEditorialQueue(...args);
export const markEditorialNotificationsRead: typeof supabase.markEditorialNotificationsRead = (...args) => impl().markEditorialNotificationsRead(...args);
