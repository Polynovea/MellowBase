// Supabase path of the dependency and impact graph reads (queries moved unchanged from
// impactGraphService.ts; deleted with the switch at the end of phase 1). The graph rules stay in
// impactGraphService.ts and are shared by both paths.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

export type EntryState = { id: string; status: string; current_draft_version_id: string | null; published_version_id: string | null };
export type OutgoingRelation = { target_entry_id: string | null; target_asset_id: string | null; target_term_id: string | null; target_route_id: string | null; target_menu_id: string | null; source_field_key: string; relation_type: string; source_version_id: string };
export type IncomingRelation = { source_entry_id: string; source_version_id: string; source_field_key: string; relation_type: string; source_menu_id: string | null; source_route_id: string | null; source_redirect_id: string | null; source_translation_id: string | null; source_release_id: string | null };
export type RouteRow = { id: string; path: string; locale: string; is_canonical: boolean; indexing_policy: string; status: string };
export type RouteRelation = { target_route_id: string | null; relation_type: string; source_entry_id: string | null; source_menu_id: string | null; source_route_id: string | null; source_redirect_id: string | null; source_translation_id: string | null; source_release_id: string | null };
export type AssetRelation = { source_entry_id: string | null; source_version_id: string; source_field_key: string; source_menu_id: string | null; source_route_id: string | null };

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST rows are untyped here */
export async function entryStates(workspaceId: string, ids: string[]): Promise<EntryState[]> {
  if (!ids.length) return [];
  const { data } = await createServiceRoleClient().from("content_entries").select("id, status, current_draft_version_id, published_version_id").eq("workspace_id", workspaceId).in("id", ids);
  return (data ?? []) as EntryState[];
}

/** Relations from one version of an entry. */
export async function outgoingRelations(workspaceId: string, entryId: string, versionId: string): Promise<OutgoingRelation[]> {
  const { data } = await createServiceRoleClient()
    .from("content_relations")
    .select("target_entry_id, target_asset_id, target_term_id, target_route_id, target_menu_id, source_field_key, relation_type, source_version_id")
    .eq("workspace_id", workspaceId)
    .eq("source_entry_id", entryId)
    .eq("source_version_id", versionId);
  return (data ?? []) as OutgoingRelation[];
}

/** Relations that point at an entry. */
export async function incomingRelations(workspaceId: string, entryId: string): Promise<IncomingRelation[]> {
  const { data } = await createServiceRoleClient()
    .from("content_relations")
    .select("source_entry_id, source_version_id, source_field_key, relation_type, source_menu_id, source_route_id, source_redirect_id, source_translation_id, source_release_id")
    .eq("workspace_id", workspaceId)
    .eq("target_entry_id", entryId);
  return (data ?? []) as IncomingRelation[];
}

/** Ids of the workspace's releases the entry belongs to (may repeat). */
export async function releaseIdsForEntry(workspaceId: string, entryId: string): Promise<string[]> {
  const { data: memberships } = await createServiceRoleClient()
    .from("release_items")
    .select("release_id, releases!inner(workspace_id, status)")
    .eq("entry_id", entryId)
    .eq("releases.workspace_id", workspaceId);
  return (memberships ?? []).map((item: any) => item.release_id);
}

/** The entry's live routes and the relations that point at them. */
export async function destinationRows(workspaceId: string, entryId: string): Promise<{ routes: RouteRow[]; routeRelations: RouteRelation[] }> {
  const db = createServiceRoleClient();
  const { data: routes } = await db.from("content_routes").select("id,path,locale,is_canonical,indexing_policy,status").eq("workspace_id", workspaceId).eq("entry_id", entryId).neq("status", "archived");
  const routeIds = (routes ?? []).map((route) => route.id);
  const { data: routeRelations } = routeIds.length
    ? await db.from("content_relations").select("target_route_id,relation_type,source_entry_id,source_menu_id,source_route_id,source_redirect_id,source_translation_id,source_release_id").eq("workspace_id", workspaceId).in("target_route_id", routeIds)
    : { data: [] as RouteRelation[] };
  return { routes: (routes ?? []) as RouteRow[], routeRelations: (routeRelations ?? []) as RouteRelation[] };
}

/** Relations that point at an asset, with the version titles, menu names and route paths they name. */
export async function assetUsageRows(workspaceId: string, assetId: string): Promise<{ relations: AssetRelation[]; versions: Array<{ id: string; data_jsonb: any }>; menus: Array<{ id: string; name: string }>; routes: Array<{ id: string; path: string }> }> {
  const db = createServiceRoleClient();
  const { data: relations } = await db
    .from("content_relations")
    .select("source_entry_id, source_version_id, source_field_key, source_menu_id, source_route_id")
    .eq("workspace_id", workspaceId)
    .eq("target_asset_id", assetId);
  const rows = (relations ?? []) as AssetRelation[];
  const versionIds = [...new Set(rows.map((r) => r.source_version_id).filter(Boolean))];
  const menuIds = [...new Set(rows.map((r) => r.source_menu_id).filter(Boolean))] as string[];
  const routeIds = [...new Set(rows.map((r) => r.source_route_id).filter(Boolean))] as string[];
  const { data: versions } = versionIds.length ? await db.from("content_entry_versions").select("id, data_jsonb").in("id", versionIds) : { data: [] };
  const { data: menus } = menuIds.length ? await db.from("navigation_menus").select("id, name").in("id", menuIds) : { data: [] };
  const { data: routes } = routeIds.length ? await db.from("content_routes").select("id, path").in("id", routeIds) : { data: [] };
  return { relations: rows, versions: (versions ?? []) as Array<{ id: string; data_jsonb: any }>, menus: (menus ?? []) as Array<{ id: string; name: string }>, routes: (routes ?? []) as Array<{ id: string; path: string }> };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
