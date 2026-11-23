// Supabase path of the queries API routes made directly (moved from app/api/**/route.ts; deleted with
// the switch at the end of phase 1). Authorization, model-access filtering and response shapes stay
// in the routes.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through as the routes read them */
export type PlatformFilter = "social" | "ads" | null;
export type PlatformInput = { name?: string; for_social?: boolean; for_ads?: boolean; is_active?: boolean; sort_order?: number };
export type MemberProfile = { id: string; username: string; display_name: string | null; email: string };

/** Platforms in display order; `social` and `ads` keep only active platforms for that channel. */
export async function listPlatforms(filter: PlatformFilter): Promise<any[]> {
  let query = createServiceRoleClient().from("platforms").select("*").order("sort_order", { ascending: true });
  if (filter === "social") query = query.eq("is_active", true).eq("for_social", true);
  if (filter === "ads") query = query.eq("is_active", true).eq("for_ads", true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** Creates an active platform at the end of the display order. */
export async function createPlatform(input: { name: string; for_social: boolean; for_ads: boolean }): Promise<any> {
  const db = createServiceRoleClient();
  const { data: maxRow } = await db.from("platforms").select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await db.from("platforms").insert({ ...input, is_active: true, sort_order: (maxRow?.sort_order ?? -1) + 1 }).select().single();
  if (error) throw error;
  return data;
}

/** Updates a platform; null when it does not exist. */
export async function updatePlatform(id: string, patch: PlatformInput): Promise<any | null> {
  const { data, error } = await createServiceRoleClient().from("platforms").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function deletePlatform(id: string): Promise<void> {
  const { error } = await createServiceRoleClient().from("platforms").delete().eq("id", id);
  if (error) throw error;
}

/** Ids of the workspace's entries in the given models. */
export async function entryIdsInModels(workspaceId: string, modelIds: string[]): Promise<string[]> {
  if (!modelIds.length) return [];
  const { data } = await createServiceRoleClient().from("content_entries").select("id, content_model_id").eq("workspace_id", workspaceId).in("content_model_id", modelIds);
  return (data ?? []).map((entry) => entry.id);
}

export async function searchDocuments(workspaceId: string, entryIds: string[]): Promise<Array<{ entry_id: string; search_text: string; status: string; locale: string }>> {
  if (!entryIds.length) return [];
  const { data } = await createServiceRoleClient().from("content_search_documents").select("entry_id, search_text, status, locale").eq("workspace_id", workspaceId).in("entry_id", entryIds);
  return data ?? [];
}

/** Profiles of the workspace's active members whose accounts are active. */
export async function activeMemberProfiles(workspaceId: string): Promise<MemberProfile[]> {
  const db = createServiceRoleClient();
  const { data: memberRows } = await db.from("workspace_members").select("admin_user_id").eq("workspace_id", workspaceId).eq("status", "active");
  const ids = (memberRows ?? []).map((row) => row.admin_user_id);
  if (!ids.length) return [];
  const { data: users } = await db.from("admin_users").select("id, username, display_name, email").in("id", ids).eq("is_active", true);
  return users ?? [];
}

/** True when a registered asset of the workspace uses the storage key. */
export async function storageKeyRegistered(workspaceId: string, storageKey: string): Promise<boolean> {
  const { data, error } = await createServiceRoleClient().from("assets").select("id").eq("workspace_id", workspaceId).eq("storage_key", storageKey).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

/** The workspace's extension installations, newest first, each with its manifest summary. */
export async function extensionInstallations(workspaceId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("extension_installations").select("*,extension_manifests(extension_key,name,version,publisher,manifest_sha256)").eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function importRuns(workspaceId: string): Promise<any[]> {
  const { data } = await createServiceRoleClient().from("developer_import_runs").select("id,content_model_id,format,mode,status,source_name,locale,total_rows,succeeded_rows,failed_rows,errors_json,result_json,created_at,completed_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(100);
  return data ?? [];
}

export async function schemaRuns(workspaceId: string): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from("developer_schema_runs").select("id,operation,status,source_environment,target_environment,bundle_hash,summary_json,approval_note,created_at,completed_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return data ?? [];
}

/** The model API key of each given version of the workspace (versions elsewhere are left out). */
export async function versionModelKeys(workspaceId: string, versionIds: string[]): Promise<Array<{ id: string; apiKey: string | null }>> {
  if (!versionIds.length) return [];
  // The relationships are named: content_entries and content_models are linked by more than one key,
  // and an unnamed embed fails (PGRST201), which used to read as "no versions" and deny nothing.
  const { data, error } = await createServiceRoleClient().from("content_entry_versions").select("id,content_entries!content_entry_versions_entry_id_fkey!inner(workspace_id,content_models!content_entries_workspace_model_fk!inner(api_key))").in("id", versionIds).eq("content_entries.workspace_id", workspaceId);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ id: row.id, apiKey: row.content_entries?.content_models?.api_key ?? null }));
}

/** The model API key of each given entry of the workspace (entries elsewhere are left out). */
export async function entryModelKeys(workspaceId: string, entryIds: string[]): Promise<Array<{ id: string; apiKey: string | null }>> {
  if (!entryIds.length) return [];
  // Named relationship, as above; a failed read used to make every release look allowed.
  const { data, error } = await createServiceRoleClient().from("content_entries").select("id,content_models!content_entries_workspace_model_fk!inner(api_key)").in("id", entryIds).eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({ id: row.id, apiKey: row.content_models?.api_key ?? null }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */
