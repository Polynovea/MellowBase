// Direct PostgreSQL implementation of the content collaboration service (phase 1, wave 3).
//
// Same signatures and return shapes as collaborationService.supabase.ts. Differences that are
// deliberate:
// - Embeds become explicit joins scoped by workspace: comment mentions are read through their comment
//   (content_comment_mentions has no workspace_id), the queue's entry and model are joined on
//   (id, workspace_id), and its release on (id, workspace_id).
// - Assigning (assignment, notification, audit) and commenting (comment, mentions, notifications,
//   audit) each commit in one transaction; the Supabase path ignored errors from the follow-up writes.
// - Only active workspace members can be mentioned (on both paths): a mention notifies its recipient
//   about the entry.
// - Database text never reaches the caller; lists have explicit limits and id tie-breaks.
import { sql } from "kysely";
import { DEFAULT_LIST_LIMIT, getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { getEntry } from "@/lib/content/entryService";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { CollaborationResult } from "@/lib/content/collaborationService";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through to the API as before */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

async function requireEntry(workspaceId: string, entryId: string) {
  const entry = await getEntry(workspaceId, entryId);
  return entry ? { ok: true as const, entry } : { ok: false as const, error: "Entry not found in this workspace", status: 404 };
}

export async function getEntryCollaboration(workspaceId: string, entryId: string): Promise<CollaborationResult<unknown>> {
  const found = await requireEntry(workspaceId, entryId); if (!found.ok) return found;
  const db = getDb();
  const [assignments, comments, mentions, watchers] = await Promise.all([
    db.selectFrom("content_assignments").selectAll().where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId)
      .orderBy(sql`due_at asc nulls last`).orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("content_comments").selectAll().where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId)
      .orderBy("created_at", "asc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("content_comment_mentions as m").innerJoin("content_comments as c", "c.id", "m.comment_id")
      .select(["m.comment_id", "m.mentioned_admin_user_id"])
      .where("c.workspace_id", "=", workspaceId).where("c.entry_id", "=", entryId).execute(),
    db.selectFrom("content_entry_watchers").select("admin_user_id").where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId).orderBy("admin_user_id").execute(),
  ]);
  const mentionsByComment = new Map<string, Array<{ mentioned_admin_user_id: string }>>();
  for (const mention of mentions) {
    if (!mentionsByComment.has(mention.comment_id)) mentionsByComment.set(mention.comment_id, []);
    mentionsByComment.get(mention.comment_id)!.push({ mentioned_admin_user_id: mention.mentioned_admin_user_id });
  }
  return {
    ok: true,
    data: {
      assignments,
      comments: comments.map((comment) => ({ ...comment, content_comment_mentions: mentionsByComment.get(comment.id) ?? [] })),
      watcherAdminUserIds: watchers.map((row) => row.admin_user_id),
    },
  };
}

export async function assignEntry(params: { workspaceId: string; entryId: string; actorId: string; assigneeId: string; role: "owner" | "author" | "reviewer" | "approver"; dueAt?: string | null; note?: string | null }): Promise<CollaborationResult<unknown>> {
  const found = await requireEntry(params.workspaceId, params.entryId); if (!found.ok) return found;
  if (params.dueAt && Number.isNaN(Date.parse(params.dueAt))) return { ok: false, error: "dueAt must be a valid ISO date", status: 400 };
  if (!isUuid(params.assigneeId)) return { ok: false, error: "Assignee is not an active member of this workspace", status: 400 };
  const member = maybeOne(await getDb().selectFrom("workspace_members").select("id")
    .where("workspace_id", "=", params.workspaceId).where("admin_user_id", "=", params.assigneeId).where("status", "=", "active").execute());
  if (!member) return { ok: false, error: "Assignee is not an active member of this workspace", status: 400 };
  try {
    const data = await withTransaction(async (trx) => {
      const values = { workspace_id: params.workspaceId, entry_id: params.entryId, assigned_to_admin_user_id: params.assigneeId, assigned_by_admin_user_id: params.actorId, role: params.role, due_at: params.dueAt ?? null, note: params.note?.trim() || null, status: "active", updated_at: new Date().toISOString() };
      const assignment = await trx.insertInto("content_assignments").values(values)
        // Same as the Supabase upsert on (entry_id, assigned_to_admin_user_id, role): every column it sent.
        .onConflict((conflict) => conflict.columns(["entry_id", "assigned_to_admin_user_id", "role"]).doUpdateSet((eb) => ({
          workspace_id: eb.ref("excluded.workspace_id"), assigned_by_admin_user_id: eb.ref("excluded.assigned_by_admin_user_id"), due_at: eb.ref("excluded.due_at"),
          note: eb.ref("excluded.note"), status: eb.ref("excluded.status"), updated_at: eb.ref("excluded.updated_at"),
        })))
        .returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("editorial_notifications").values({ workspace_id: params.workspaceId, recipient_admin_user_id: params.assigneeId, entry_id: params.entryId, kind: "assignment", payload_json: JSON.stringify({ role: params.role, dueAt: params.dueAt ?? null }) }).execute();
      await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "content.entry.assigned", entityType: "content_entry", entityId: params.entryId, metadata: { assigneeId: params.assigneeId, role: params.role } });
      return assignment;
    });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: clientErrorMessage(error, "Could not save assignment"), status: 500 };
  }
}

export async function addComment(params: { workspaceId: string; entryId: string; actorId: string; body: string; parentCommentId?: string | null; mentionIds?: string[] }): Promise<CollaborationResult<unknown>> {
  const found = await requireEntry(params.workspaceId, params.entryId); if (!found.ok) return found;
  const body = params.body.trim(); if (!body || body.length > 8000) return { ok: false, error: "Comment must contain 1–8000 characters", status: 400 };
  const db = getDb();
  if (params.parentCommentId) {
    const parent = isUuid(params.parentCommentId) && maybeOne(await db.selectFrom("content_comments").select("id")
      .where("id", "=", params.parentCommentId).where("workspace_id", "=", params.workspaceId).where("entry_id", "=", params.entryId).execute());
    if (!parent) return { ok: false, error: "Parent comment is not on this entry", status: 400 };
  }
  const requested = [...new Set((params.mentionIds ?? []).filter(Boolean))].filter((id) => id !== params.actorId && isUuid(id));
  const members = requested.length
    ? await db.selectFrom("workspace_members").select("admin_user_id").where("workspace_id", "=", params.workspaceId).where("status", "=", "active").where("admin_user_id", "in", requested).execute()
    : [];
  const memberIds = new Set(members.map((member) => member.admin_user_id));
  const mentionIds = requested.filter((id) => memberIds.has(id));
  try {
    const data = await withTransaction(async (trx) => {
      const comment = await trx.insertInto("content_comments").values({ workspace_id: params.workspaceId, entry_id: params.entryId, entry_version_id: found.entry.current_draft_version_id, parent_comment_id: params.parentCommentId ?? null, author_admin_user_id: params.actorId, body })
        .returningAll().executeTakeFirstOrThrow();
      if (mentionIds.length) {
        await trx.insertInto("content_comment_mentions").values(mentionIds.map((mentioned_admin_user_id) => ({ comment_id: comment.id, mentioned_admin_user_id }))).execute();
        await trx.insertInto("editorial_notifications").values(mentionIds.map((recipient_admin_user_id) => ({ workspace_id: params.workspaceId, recipient_admin_user_id, entry_id: params.entryId, kind: "mention", payload_json: JSON.stringify({ commentId: comment.id }) }))).execute();
      }
      await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "content.entry.comment_added", entityType: "content_entry", entityId: params.entryId, metadata: { commentId: comment.id, mentions: mentionIds.length } });
      return comment;
    });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: clientErrorMessage(error, "Could not add comment"), status: 500 };
  }
}

export async function setWatch(params: { workspaceId: string; entryId: string; actorId: string; watching: boolean }): Promise<CollaborationResult<{ watching: boolean }>> {
  const found = await requireEntry(params.workspaceId, params.entryId); if (!found.ok) return found;
  await withTransaction(async (trx) => {
    if (params.watching) {
      await trx.insertInto("content_entry_watchers").values({ workspace_id: params.workspaceId, entry_id: params.entryId, admin_user_id: params.actorId })
        .onConflict((conflict) => conflict.columns(["entry_id", "admin_user_id"]).doUpdateSet((eb) => ({ workspace_id: eb.ref("excluded.workspace_id") }))).execute();
    } else {
      await trx.deleteFrom("content_entry_watchers").where("workspace_id", "=", params.workspaceId).where("entry_id", "=", params.entryId).where("admin_user_id", "=", params.actorId).execute();
    }
    await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: params.watching ? "content.entry.watched" : "content.entry.unwatched", entityType: "content_entry", entityId: params.entryId });
  });
  return { ok: true, data: { watching: params.watching } };
}

export async function resolveComment(params: { workspaceId: string; entryId: string; commentId: string; actorId: string }): Promise<CollaborationResult<unknown>> {
  const found = await requireEntry(params.workspaceId, params.entryId); if (!found.ok) return found;
  if (!isUuid(params.commentId)) return { ok: false, error: "Open comment not found on this entry", status: 404 };
  try {
    const data = await withTransaction(async (trx) => {
      const now = new Date().toISOString();
      const row = maybeOne(await trx.updateTable("content_comments").set({ status: "resolved", resolved_by_admin_user_id: params.actorId, resolved_at: now, updated_at: now })
        .where("id", "=", params.commentId).where("workspace_id", "=", params.workspaceId).where("entry_id", "=", params.entryId).where("status", "=", "open")
        .returningAll().execute());
      if (row) await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "content.entry.comment_resolved", entityType: "content_entry", entityId: params.entryId, metadata: { commentId: params.commentId } });
      return row;
    });
    if (!data) return { ok: false, error: "Open comment not found on this entry", status: 404 };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: clientErrorMessage(error, "Could not resolve comment"), status: 500 };
  }
}

export async function getMyEditorialQueue(workspaceId: string, actorId: string): Promise<CollaborationResult<unknown>> {
  if (!isUuid(actorId)) return { ok: true, data: { assignments: [], releaseAssignments: [], notifications: [] } };
  const db = getDb();
  const [assignments, releaseAssignments, notifications] = await Promise.all([
    db.selectFrom("content_assignments as a")
      .leftJoin("content_entries as e", (join) => join.onRef("e.id", "=", "a.entry_id").onRef("e.workspace_id", "=", "a.workspace_id"))
      .leftJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
      .select(["a.id", "a.entry_id", "a.role", "a.due_at", "a.note", "a.created_at", "e.status as entry_status", "e.id as entry_found", "m.name as model_name", "m.api_key as model_api_key"])
      .where("a.workspace_id", "=", workspaceId).where("a.assigned_to_admin_user_id", "=", actorId).where("a.status", "=", "active")
      .orderBy(sql`a.due_at asc nulls last`).orderBy("a.id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("release_assignments as a")
      .leftJoin("releases as r", (join) => join.onRef("r.id", "=", "a.release_id").onRef("r.workspace_id", "=", "a.workspace_id"))
      .select(["a.id", "a.release_id", "a.role", "a.due_at", "a.note", "a.created_at", "r.id as release_found", "r.name as release_name", "r.status as release_status", "r.scheduled_for as release_scheduled_for"])
      .where("a.workspace_id", "=", workspaceId).where("a.assigned_to_admin_user_id", "=", actorId).where("a.status", "=", "active")
      .orderBy(sql`a.due_at asc nulls last`).orderBy("a.id").limit(DEFAULT_LIST_LIMIT).execute(),
    db.selectFrom("editorial_notifications").select(["id", "entry_id", "release_id", "kind", "payload_json", "created_at"])
      .where("workspace_id", "=", workspaceId).where("recipient_admin_user_id", "=", actorId).where("read_at", "is", null)
      .orderBy("created_at", "desc").orderBy("id", "desc").limit(50).execute(),
  ]);
  return {
    ok: true,
    data: {
      assignments: assignments.map(({ entry_status, entry_found, model_name, model_api_key, ...row }) => ({
        ...row,
        content_entries: entry_found ? { status: entry_status, content_models: model_api_key ? { name: model_name, api_key: model_api_key } : null } : null,
      })),
      releaseAssignments: releaseAssignments.map(({ release_found, release_name, release_status, release_scheduled_for, ...row }) => ({
        ...row,
        releases: release_found ? { name: release_name, status: release_status, scheduled_for: release_scheduled_for } : null,
      })),
      notifications,
    },
  };
}

export async function markEditorialNotificationsRead(params: { workspaceId: string; actorId: string; notificationIds?: string[]; all?: boolean }): Promise<CollaborationResult<{ updated: number }>> {
  let ids: string[] = [];
  if (!params.all) {
    ids = [...new Set((params.notificationIds ?? []).filter(Boolean))].slice(0, 100);
    if (!ids.length) return { ok: false, error: "notificationIds is required unless all=true", status: 400 };
    ids = ids.filter(isUuid);
  }
  try {
    const updated = await withTransaction(async (trx) => {
      let query = trx.updateTable("editorial_notifications").set({ read_at: new Date().toISOString() })
        .where("workspace_id", "=", params.workspaceId).where("recipient_admin_user_id", "=", params.actorId).where("read_at", "is", null);
      if (!params.all) {
        if (!ids.length) return 0;
        query = query.where("id", "in", ids);
      }
      const rows = await query.returning("id").execute();
      await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "editorial.notifications.read", entityType: "editorial_notification", entityId: null, metadata: { updated: rows.length, all: Boolean(params.all) } });
      return rows.length;
    });
    return { ok: true, data: { updated } };
  } catch (error) {
    return { ok: false, error: clientErrorMessage(error, "Could not mark notifications read"), status: 500 };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
