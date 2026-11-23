// PostgreSQL implementation of the dependency and impact graph reads (phase 1, wave 3). Deliberate
// differences from the Supabase path it replaced in phase 1:
// - Every read is scoped by workspace: version titles through the entry's workspace
// (content_entry_versions has no workspace_id), and menu names and route paths by workspace_id
// (the Supabase path looked them up by id alone).
// - Release membership is an explicit join scoped on the release's workspace.
// - Reads are not capped at 1000 rows (PostgREST's cap undercounted a widely used entry's or
// asset's blast radius) and come back in a fixed order.
import { getDb } from "@/lib/db/index";

export type EntryState = { id: string; status: string; current_draft_version_id: string | null; published_version_id: string | null };
export type OutgoingRelation = { target_entry_id: string | null; target_asset_id: string | null; target_term_id: string | null; target_route_id: string | null; target_menu_id: string | null; source_field_key: string; relation_type: string; source_version_id: string };
export type IncomingRelation = { source_entry_id: string; source_version_id: string; source_field_key: string; relation_type: string; source_menu_id: string | null; source_route_id: string | null; source_redirect_id: string | null; source_translation_id: string | null; source_release_id: string | null };
export type RouteRow = { id: string; path: string; locale: string; is_canonical: boolean; indexing_policy: string; status: string };
export type RouteRelation = { target_route_id: string | null; relation_type: string; source_entry_id: string | null; source_menu_id: string | null; source_route_id: string | null; source_redirect_id: string | null; source_translation_id: string | null; source_release_id: string | null };
export type AssetRelation = { source_entry_id: string | null; source_version_id: string; source_field_key: string; source_menu_id: string | null; source_route_id: string | null };


/* eslint-disable @typescript-eslint/no-explicit-any -- version data is free-form JSON */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: string[]) => [...new Set(ids.filter((id) => UUID.test(id)))];

export async function entryStates(workspaceId: string, ids: string[]): Promise<EntryState[]> {
  const valid = uuids(ids);
  if (!valid.length) return [];
  return getDb().selectFrom("content_entries").select(["id", "status", "current_draft_version_id", "published_version_id"])
    .where("workspace_id", "=", workspaceId).where("id", "in", valid).orderBy("id").execute();
}

export async function outgoingRelations(workspaceId: string, entryId: string, versionId: string): Promise<OutgoingRelation[]> {
  if (!UUID.test(entryId) || !UUID.test(versionId)) return [];
  return await getDb().selectFrom("content_relations")
    .select(["target_entry_id", "target_asset_id", "target_term_id", "target_route_id", "target_menu_id", "source_field_key", "relation_type", "source_version_id"])
    .where("workspace_id", "=", workspaceId).where("source_entry_id", "=", entryId).where("source_version_id", "=", versionId)
    .orderBy("id").execute() as OutgoingRelation[];
}

export async function incomingRelations(workspaceId: string, entryId: string): Promise<IncomingRelation[]> {
  if (!UUID.test(entryId)) return [];
  return await getDb().selectFrom("content_relations")
    .select(["source_entry_id", "source_version_id", "source_field_key", "relation_type", "source_menu_id", "source_route_id", "source_redirect_id", "source_translation_id", "source_release_id"])
    .where("workspace_id", "=", workspaceId).where("target_entry_id", "=", entryId)
    .orderBy("id").execute() as IncomingRelation[];
}

export async function releaseIdsForEntry(workspaceId: string, entryId: string): Promise<string[]> {
  if (!UUID.test(entryId)) return [];
  const rows = await getDb().selectFrom("release_items as ri").innerJoin("releases as r", "r.id", "ri.release_id")
    .select("ri.release_id").where("r.workspace_id", "=", workspaceId).where("ri.entry_id", "=", entryId)
    .orderBy("ri.release_id").execute();
  return rows.map((row) => row.release_id);
}

export async function destinationRows(workspaceId: string, entryId: string): Promise<{ routes: RouteRow[]; routeRelations: RouteRelation[] }> {
  if (!UUID.test(entryId)) return { routes: [], routeRelations: [] };
  const db = getDb();
  const routes = await db.selectFrom("content_routes").select(["id", "path", "locale", "is_canonical", "indexing_policy", "status"])
    .where("workspace_id", "=", workspaceId).where("entry_id", "=", entryId).where("status", "!=", "archived")
    .orderBy("path").orderBy("id").execute() as RouteRow[];
  const routeIds = routes.map((route) => route.id);
  const routeRelations = routeIds.length
    ? await db.selectFrom("content_relations")
      .select(["target_route_id", "relation_type", "source_entry_id", "source_menu_id", "source_route_id", "source_redirect_id", "source_translation_id", "source_release_id"])
      .where("workspace_id", "=", workspaceId).where("target_route_id", "in", routeIds)
      .orderBy("id").execute() as RouteRelation[]
    : [];
  return { routes, routeRelations };
}

export async function assetUsageRows(workspaceId: string, assetId: string): Promise<{ relations: AssetRelation[]; versions: Array<{ id: string; data_jsonb: any }>; menus: Array<{ id: string; name: string }>; routes: Array<{ id: string; path: string }> }> {
  if (!UUID.test(assetId)) return { relations: [], versions: [], menus: [], routes: [] };
  const db = getDb();
  const relations = await db.selectFrom("content_relations")
    .select(["source_entry_id", "source_version_id", "source_field_key", "source_menu_id", "source_route_id"])
    .where("workspace_id", "=", workspaceId).where("target_asset_id", "=", assetId)
    .orderBy("id").execute() as AssetRelation[];
  const versionIds = uuids(relations.map((r) => r.source_version_id).filter(Boolean));
  const menuIds = uuids(relations.map((r) => r.source_menu_id).filter((id): id is string => Boolean(id)));
  const routeIds = uuids(relations.map((r) => r.source_route_id).filter((id): id is string => Boolean(id)));
  const [versions, menus, routes] = await Promise.all([
    versionIds.length
      ? db.selectFrom("content_entry_versions as v").innerJoin("content_entries as e", "e.id", "v.entry_id")
        .select(["v.id", "v.data_jsonb"]).where("e.workspace_id", "=", workspaceId).where("v.id", "in", versionIds).execute()
      : [],
    menuIds.length ? db.selectFrom("navigation_menus").select(["id", "name"]).where("workspace_id", "=", workspaceId).where("id", "in", menuIds).execute() : [],
    routeIds.length ? db.selectFrom("content_routes").select(["id", "path"]).where("workspace_id", "=", workspaceId).where("id", "in", routeIds).execute() : [],
  ]);
  return { relations, versions: versions as Array<{ id: string; data_jsonb: any }>, menus, routes };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
