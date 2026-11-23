// Supabase path of the release and editorial-calendar primitives (queries moved unchanged from
// releaseService.ts and calendarService.ts; deleted with the switch at the end of phase 1). The
// readiness, scheduling and calendar rules stay in those services and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent, type PlatformAuditPayload } from "@/lib/platform/audit";
import type { ReleaseFunctionName, ReleaseFunctionResult } from "@/lib/content/releaseData";

/* eslint-disable @typescript-eslint/no-explicit-any -- release rows are passed through to the API as before */
export async function listReleases(workspaceId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient()
    .from("releases")
    .select("*, release_items(id,entry_id,entry_version_id,delivery_status,delivery_error), release_locale_targets(locale,required)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getRelease(workspaceId: string, releaseId: string): Promise<any | null> {
  // A malformed ID is "not found" (PostgREST reported it as an error), as on the direct path.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(releaseId)) return null;
  const { data, error } = await createServiceRoleClient()
    .from("releases")
    .select(`
      *,
      release_items(
        id,entry_id,entry_version_id,delivery_status,delivery_error,created_at,
        content_entries(id,status,current_draft_version_id,published_version_id,content_model_id,content_models!content_entries_workspace_model_fk(name,api_key)),
        content_entry_versions(id,locale,version_number,state,data_jsonb,created_at)
      ),
      release_locale_targets(id,locale,required),
      release_approvals(id,actor_admin_user_id,decision,comment,created_at),
      release_assignments(id,assigned_to_admin_user_id,assigned_by_admin_user_id,role,status,due_at,note,completed_at,created_at),
      release_history(id,actor_admin_user_id,action,from_status,to_status,detail_json,created_at),
      release_rollback_items(entry_id,target_version_id,previous_published_version_id,created_at)
    `)
    .eq("workspace_id", workspaceId)
    .eq("id", releaseId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Enabled, required workspace locales; an error result when they cannot be read. */
export async function requiredLocales(workspaceId: string): Promise<{ ok: true; locales: string[] } | { ok: false; code: string | null; message: string | null }> {
  const { data: requiredLocaleRows, error: requiredLocalesError } = await createServiceRoleClient()
    .from("workspace_locales")
    .select("locale")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .eq("required", true);
  if (requiredLocalesError) return { ok: false, code: requiredLocalesError.code ?? null, message: requiredLocalesError.message ?? null };
  return { ok: true, locales: (requiredLocaleRows ?? []).map((row) => row.locale).filter(Boolean) };
}

export async function translationsOfSources(workspaceId: string, sourceEntryIds: string[]): Promise<Array<{ source_entry_id: string; locale: string; translated_entry_id: string | null; source_version_id: string | null; reviewed_at: string | null; stale_at: string | null }>> {
  if (!sourceEntryIds.length) return [];
  const { data } = await createServiceRoleClient().from("content_entry_translations").select("source_entry_id,locale,translated_entry_id,source_version_id,reviewed_at,stale_at").eq("workspace_id", workspaceId).in("source_entry_id", sourceEntryIds);
  return data ?? [];
}

export async function entryRelationsFrom(workspaceId: string, sourceEntryIds: string[]): Promise<Array<{ source_entry_id: string | null; source_version_id: string | null; target_entry_id: string | null; source_field_key: string; relation_type: string }>> {
  if (!sourceEntryIds.length) return [];
  const { data } = await createServiceRoleClient().from("content_relations").select("source_entry_id,source_version_id,target_entry_id,source_field_key,relation_type").eq("workspace_id", workspaceId).in("source_entry_id", sourceEntryIds).not("target_entry_id", "is", null);
  return data ?? [];
}

export async function entryStatusesById(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; status: string }>> {
  if (!entryIds.length) return [];
  const { data } = await createServiceRoleClient().from("content_entries").select("id,status").eq("workspace_id", workspaceId).in("id", entryIds);
  return data ?? [];
}

export async function dueReleases(workspaceId: string, limit: number): Promise<Array<{ id: string; name: string; scheduled_for: string | null }>> {
  const { data, error } = await createServiceRoleClient()
    .from("releases")
    .select("id,name,scheduled_for")
    .eq("workspace_id", workspaceId)
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function callReleaseFunction(name: ReleaseFunctionName, args: Record<string, unknown>): Promise<ReleaseFunctionResult> {
  const { data, error } = await createServiceRoleClient().rpc(name, args);
  if (error || !data) return { ok: false, code: error?.code ?? null, message: error?.message ?? null };
  return { ok: true, data };
}

export async function listCalendarEvents(workspaceId: string, from?: string, to?: string): Promise<any[]> {
  let query = createServiceRoleClient().from("editorial_calendar_events").select("*").eq("workspace_id", workspaceId).order("starts_at", { ascending: true });
  if (from) query = query.gte("starts_at", from);
  if (to) query = query.lte("starts_at", to);
  const { data } = await query;
  return data ?? [];
}

export async function releaseExists(workspaceId: string, releaseId: string): Promise<boolean> {
  const { data: release } = await createServiceRoleClient().from("releases").select("id").eq("id", releaseId).eq("workspace_id", workspaceId).maybeSingle();
  return Boolean(release);
}

export async function insertCalendarEvent(row: Record<string, unknown>, audit: (event: { id: string }) => PlatformAuditPayload): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("editorial_calendar_events").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not schedule event");
  await logPlatformEvent(audit(data));
  return data;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
