// Content area, collaboration (assignments, comments, mentions, watchers, the editorial queue).
import * as postgres from "@/lib/content/collaborationService.postgres";

export type CollaborationResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };


export const getEntryCollaboration = postgres.getEntryCollaboration;
export const assignEntry = postgres.assignEntry;
export const addComment = postgres.addComment;
export const setWatch = postgres.setWatch;
export const resolveComment = postgres.resolveComment;
export const getMyEditorialQueue = postgres.getMyEditorialQueue;
export const markEditorialNotificationsRead = postgres.markEditorialNotificationsRead;
