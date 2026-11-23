// PostgreSQL implementation of the release and editorial-calendar primitives (phase 1, wave 3).
//
// The PostgREST embeds of listReleases and getRelease become explicit queries, every one scoped by
// workspace:
// - release_items has no workspace_id: items are read through their release (r.workspace_id).
// - an item's entry is joined only within the workspace, its model on (model id, workspace id), and
// its pinned version only when that version belongs to the item's (workspace-scoped) entry.
// - every other child table (locale targets, approvals, assignments, history, rollback items) is
// filtered by its own workspace_id as well as the release.
// Embedded arrays come back in a fixed order (created_at, then id); PostgREST left it undefined.
// Other differences: lifecycle functions' own messages pass through with their SQLSTATE, database
// text never does; a calendar event commits with its audit event; explicit limits.
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, SqlFunctionError, withTransaction } from "@/lib/db/index";
import { clientErrorMessage } from "@/lib/http/clientError";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { PlatformAuditPayload } from "@/lib/platform/audit";
import type { ReleaseFunctionName, ReleaseFunctionResult } from "@/lib/content/releaseData";

/* eslint-disable @typescript-eslint/no-explicit-any -- release rows are passed through to the API as before */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

function groupBy<T extends Record<string, any>>(rows: T[], key: string): Map<string, Array<Omit<T, typeof key>>> {
  const groups = new Map<string, Array<Omit<T, typeof key>>>();
  for (const row of rows) {
    const { [key]: id, ...rest } = row;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(rest);
  }
  return groups;
}

export async function listReleases(workspaceId: string): Promise<any[]> {
  const db = getDb();
  const releases = await db.selectFrom("releases").selectAll().where("workspace_id", "=", workspaceId)
    .orderBy("created_at", "desc").orderBy("id", "desc").limit(DEFAULT_LIST_LIMIT).execute();
  const ids = releases.map((release) => release.id);
  if (!ids.length) return [];
  const [items, targets] = await Promise.all([
    db.selectFrom("release_items as i").innerJoin("releases as r", "r.id", "i.release_id")
      .select(["i.release_id", "i.id", "i.entry_id", "i.entry_version_id", "i.delivery_status", "i.delivery_error"])
      .where("r.workspace_id", "=", workspaceId).where("i.release_id", "in", ids)
      .orderBy("i.created_at").orderBy("i.id").execute(),
    db.selectFrom("release_locale_targets").select(["release_id", "locale", "required"])
      .where("workspace_id", "=", workspaceId).where("release_id", "in", ids)
      .orderBy("created_at").orderBy("id").execute(),
  ]);
  const itemsByRelease = groupBy(items, "release_id");
  const targetsByRelease = groupBy(targets, "release_id");
  return releases.map((release) => ({ ...release, release_items: itemsByRelease.get(release.id) ?? [], release_locale_targets: targetsByRelease.get(release.id) ?? [] }));
}

export async function getRelease(workspaceId: string, releaseId: string): Promise<any | null> {
  if (!isUuid(releaseId)) return null;
  const db = getDb();
  const release = maybeOne(await db.selectFrom("releases").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", releaseId).execute());
  if (!release) return null;
  const child = <T extends "release_locale_targets" | "release_approvals" | "release_assignments" | "release_history" | "release_rollback_items">(table: T) =>
    db.selectFrom(table as "release_approvals").where("workspace_id", "=", workspaceId).where("release_id", "=", releaseId);

  const [items, targets, approvals, assignments, history, rollback] = await Promise.all([
    db.selectFrom("release_items as i")
      .innerJoin("releases as r", (join) => join.onRef("r.id", "=", "i.release_id"))
      .leftJoin("content_entries as e", (join) => join.onRef("e.id", "=", "i.entry_id").on("e.workspace_id", "=", workspaceId))
      .leftJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
      .leftJoin("content_entry_versions as v", (join) => join.onRef("v.id", "=", "i.entry_version_id").onRef("v.entry_id", "=", "e.id"))
      .select([
        "i.id", "i.entry_id", "i.entry_version_id", "i.delivery_status", "i.delivery_error", "i.created_at",
        "e.id as e_id", "e.status as e_status", "e.current_draft_version_id as e_draft", "e.published_version_id as e_published", "e.content_model_id as e_model",
        "m.name as m_name", "m.api_key as m_api_key",
        "v.id as v_id", "v.locale as v_locale", "v.version_number as v_number", "v.state as v_state", "v.data_jsonb as v_data", "v.created_at as v_created_at",
      ])
      .where("r.workspace_id", "=", workspaceId).where("i.release_id", "=", releaseId)
      .orderBy("i.created_at").orderBy("i.id").execute(),
    db.selectFrom("release_locale_targets").select(["id", "locale", "required"]).where("workspace_id", "=", workspaceId).where("release_id", "=", releaseId).orderBy("created_at").orderBy("id").execute(),
    child("release_approvals").select(["id", "actor_admin_user_id", "decision", "comment", "created_at"]).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("release_assignments").select(["id", "assigned_to_admin_user_id", "assigned_by_admin_user_id", "role", "status", "due_at", "note", "completed_at", "created_at"])
      .where("workspace_id", "=", workspaceId).where("release_id", "=", releaseId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("release_history").select(["id", "actor_admin_user_id", "action", "from_status", "to_status", "detail_json", "created_at"])
      .where("workspace_id", "=", workspaceId).where("release_id", "=", releaseId).orderBy("created_at").orderBy("id").execute(),
    db.selectFrom("release_rollback_items").select(["entry_id", "target_version_id", "previous_published_version_id", "created_at"])
      .where("workspace_id", "=", workspaceId).where("release_id", "=", releaseId).orderBy("created_at").orderBy("id").execute(),
  ]);

  return {
    ...release,
    release_items: items.map((row) => ({
      id: row.id, entry_id: row.entry_id, entry_version_id: row.entry_version_id, delivery_status: row.delivery_status, delivery_error: row.delivery_error, created_at: row.created_at,
      content_entries: row.e_id
        ? { id: row.e_id, status: row.e_status, current_draft_version_id: row.e_draft, published_version_id: row.e_published, content_model_id: row.e_model, content_models: row.m_api_key ? { name: row.m_name, api_key: row.m_api_key } : null }
        : null,
      content_entry_versions: row.v_id
        ? { id: row.v_id, locale: row.v_locale, version_number: row.v_number, state: row.v_state, data_jsonb: row.v_data, created_at: row.v_created_at }
        : null,
    })),
    release_locale_targets: targets,
    release_approvals: approvals,
    release_assignments: assignments,
    release_history: history,
    release_rollback_items: rollback,
  };
}

export async function requiredLocales(workspaceId: string): Promise<{ ok: true; locales: string[] } | { ok: false; code: string | null; message: string | null }> {
  try {
    const rows = await getDb().selectFrom("workspace_locales").select("locale")
      .where("workspace_id", "=", workspaceId).where("enabled", "=", true).where("required", "=", true).orderBy("locale").execute();
    return { ok: true, locales: rows.map((row) => row.locale).filter(Boolean) };
  } catch (error) {
    return { ok: false, code: null, message: clientErrorMessage(error, "Could not resolve required workspace locales") };
  }
}

export async function translationsOfSources(workspaceId: string, sourceEntryIds: string[]): Promise<Array<{ source_entry_id: string; locale: string; translated_entry_id: string | null; source_version_id: string | null; reviewed_at: string | null; stale_at: string | null }>> {
  const ids = sourceEntryIds.filter(isUuid);
  if (!ids.length) return [];
  return getDb().selectFrom("content_entry_translations").select(["source_entry_id", "locale", "translated_entry_id", "source_version_id", "reviewed_at", "stale_at"])
    .where("workspace_id", "=", workspaceId).where("source_entry_id", "in", ids).orderBy("created_at").orderBy("id").execute();
}

export async function entryRelationsFrom(workspaceId: string, sourceEntryIds: string[]): Promise<Array<{ source_entry_id: string | null; source_version_id: string | null; target_entry_id: string | null; source_field_key: string; relation_type: string }>> {
  const ids = sourceEntryIds.filter(isUuid);
  if (!ids.length) return [];
  return getDb().selectFrom("content_relations").select(["source_entry_id", "source_version_id", "target_entry_id", "source_field_key", "relation_type"])
    .where("workspace_id", "=", workspaceId).where("source_entry_id", "in", ids).where("target_entry_id", "is not", null)
    .orderBy("created_at").orderBy("id").execute() as Promise<any>;
}

export async function entryStatusesById(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; status: string }>> {
  const ids = entryIds.filter(isUuid);
  if (!ids.length) return [];
  return getDb().selectFrom("content_entries").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "in", ids).execute();
}

export async function dueReleases(workspaceId: string, limit: number): Promise<Array<{ id: string; name: string; scheduled_for: string | null }>> {
  return getDb().selectFrom("releases").select(["id", "name", "scheduled_for"])
    .where("workspace_id", "=", workspaceId).where("status", "=", "scheduled").where("scheduled_for", "<=", new Date().toISOString())
    .orderBy("scheduled_for", "asc").orderBy("id").limit(limit).execute();
}

const JSON_ARGS = new Set(["p_item_version_ids", "p_locales"]);

export async function callReleaseFunction(name: ReleaseFunctionName, args: Record<string, unknown>): Promise<ReleaseFunctionResult> {
  // jsonb arguments are serialized here; the driver would send a JS array as a PostgreSQL array.
  const prepared = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON_ARGS.has(key) && value != null ? JSON.stringify(value) : value]));
  try {
    const data = await callFunction(name, prepared as never);
    if (!data) return { ok: false, code: null, message: null };
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SqlFunctionError) return { ok: false, code: error.sqlState, message: error.message };
    return { ok: false, code: null, message: clientErrorMessage(error, `Could not complete ${name}`) };
  }
}

export async function listCalendarEvents(workspaceId: string, from?: string, to?: string): Promise<any[]> {
  let query = getDb().selectFrom("editorial_calendar_events").selectAll().where("workspace_id", "=", workspaceId);
  if (from) query = query.where("starts_at", ">=", from);
  if (to) query = query.where("starts_at", "<=", to);
  return query.orderBy("starts_at", "asc").orderBy("id").limit(DEFAULT_LIST_LIMIT).execute();
}

export async function releaseExists(workspaceId: string, releaseId: string): Promise<boolean> {
  if (!isUuid(releaseId)) return false;
  return Boolean(maybeOne(await getDb().selectFrom("releases").select("id").where("id", "=", releaseId).where("workspace_id", "=", workspaceId).execute()));
}

export async function insertCalendarEvent(row: Record<string, unknown>, audit: (event: { id: string }) => PlatformAuditPayload): Promise<any> {
  return withTransaction(async (trx) => {
    const event = expectOne(await trx.insertInto("editorial_calendar_events").values(row as any).returningAll().execute(), "Could not schedule event");
    await recordPlatformEvent(trx, audit(event));
    return event;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
