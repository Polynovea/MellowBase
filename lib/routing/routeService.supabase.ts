// Supabase path of the routing area's route service (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import { buildRouteTree, collectRouteRelations, normalizePath } from "@/lib/routing/routePaths";
import type { RouteRow } from "@/lib/routing/routeService";

export async function checkPathCollision(params: {
  workspaceId: string;
  locale: string;
  path: string;
  excludeRouteId?: string;
}): Promise<{ isCollision: boolean; conflictingRoute?: RouteRow | null; normalizedPath: string; error?: string }> {
  const norm = normalizePath(params.path);
  if (!norm.ok) {
    return { isCollision: true, error: norm.error, normalizedPath: params.path };
  }

  const db = createServiceRoleClient();
  let query = db
    .from("content_routes")
    .select("*")
    .eq("workspace_id", params.workspaceId)
    .eq("locale", params.locale)
    .eq("path", norm.path)
    .neq("status", "archived");

  if (params.excludeRouteId) {
    query = query.neq("id", params.excludeRouteId);
  }

  const { data } = await query.maybeSingle();
  return {
    isCollision: Boolean(data),
    conflictingRoute: (data as RouteRow) ?? null,
    normalizedPath: norm.path,
  };
}

export async function listRoutes(workspaceId: string, locale?: string): Promise<RouteRow[]> {
  const db = createServiceRoleClient();
  let query = db
    .from("content_routes")
    .select("*")
    .eq("workspace_id", workspaceId)
    .neq("status", "archived")
    .order("order_index", { ascending: true })
    .order("path", { ascending: true });

  if (locale) {
    query = query.eq("locale", locale);
  }

  const { data } = await query;
  return (data as RouteRow[]) ?? [];
}

export async function getSiteTree(workspaceId: string, locale: string = "en"): Promise<RouteRow[]> {
  return buildRouteTree(await listRoutes(workspaceId, locale));
}

export async function registerRoute(params: {
  workspaceId: string;
  actorAdminUserId: string;
  locale: string;
  path: string;
  title?: string | null;
  entryId?: string | null;
  parentRouteId?: string | null;
  nodeType?: "routable_entry" | "virtual_folder" | "external_link" | "custom_path";
  isCanonical?: boolean;
  orderIndex?: number;
  metadata?: Record<string, unknown>;
}): Promise<RouteRow> {
  const norm = normalizePath(params.path);
  if (!norm.ok) throw new Error(norm.error);

  const collision = await checkPathCollision({
    workspaceId: params.workspaceId,
    locale: params.locale,
    path: norm.path,
  });
  if (collision.isCollision) {
    throw new Error(`Route collision: path '${norm.path}' is already in use in locale '${params.locale}'`);
  }

  const db = createServiceRoleClient();
  const isCanonical = params.isCanonical ?? true;

  // If this is canonical for an entry, un-canonicalize any existing route for this entry/locale
  if (isCanonical && params.entryId) {
    await db
      .from("content_routes")
      .update({ is_canonical: false, updated_at: new Date().toISOString() })
      .eq("workspace_id", params.workspaceId)
      .eq("entry_id", params.entryId)
      .eq("locale", params.locale);
  }

  const { data: route, error } = await db
    .from("content_routes")
    .insert({
      workspace_id: params.workspaceId,
      parent_route_id: params.parentRouteId || null,
      entry_id: params.entryId || null,
      locale: params.locale,
      path: norm.path,
      title: params.title?.trim() || null,
      node_type: params.nodeType || "routable_entry",
      is_canonical: isCanonical,
      status: "active",
      order_index: params.orderIndex ?? 0,
      metadata_json: params.metadata || {},
    })
    .select()
    .single();

  if (error || !route) throw new Error(error?.message || "Could not create route");

  await syncRouteRelations(params.workspaceId, route.id, route.entry_id, params.metadata);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "routing.route.created",
    entityType: "route",
    entityId: route.id,
    metadata: { path: route.path, locale: route.locale, entryId: route.entry_id },
  });

  return route as RouteRow;
}

/**
 * Synchronize generic dependency graph edges for a content route.
 */
export async function syncRouteRelations(
  workspaceId: string,
  routeId: string,
  entryId?: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  const db = createServiceRoleClient();

  const rows = collectRouteRelations(workspaceId, routeId, entryId, metadata);

  // Atomic stored procedure to maintain generic dependency graph edges without non-atomic fallback
  const { error } = await db.rpc("cms_replace_source_relations", {
    p_workspace_id: workspaceId,
    p_source_type: "route",
    p_source_id: routeId,
    p_relations: rows,
  });
  if (error) {
    throw new Error(`Failed to replace route relations: ${error.message}`);
  }
}

/**
 * Atomic Route Path Change:
 * 1. Validates and normalizes new path without collision.
 * 2. Updates route path in content_routes.
 * 3. Records previous path in content_route_history.
 * 4. Automatically creates a 301 permanent redirect from old_path to new_path in content_redirects.
 * 5. Logs platform audit event inside the PostgreSQL transaction.
 */
export async function updateRoutePath(params: {
  workspaceId: string;
  actorAdminUserId: string;
  routeId: string;
  newPath: string;
  title?: string;
  parentRouteId?: string | null;
  orderIndex?: number;
}): Promise<{ route: RouteRow; redirectCreated: boolean }> {
  const norm = normalizePath(params.newPath);
  if (!norm.ok) throw new Error(norm.error);

  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("cms_update_route_path", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorAdminUserId,
    p_route_id: params.routeId,
    p_new_path: norm.path,
    p_title: params.title?.trim() || null,
    p_parent_route_id: params.parentRouteId !== undefined ? params.parentRouteId : null,
    p_order_index: params.orderIndex ?? null,
    p_parent_route_id_supplied: params.parentRouteId !== undefined,
  });

  if (error || !data) throw new Error(error?.message || "Could not update route path");

  const result = data as { route: RouteRow; redirectCreated: boolean };
  await syncRouteRelations(params.workspaceId, result.route.id, result.route.entry_id, result.route.metadata_json);

  return result;
}

export async function updateRouteDiscoverability(params: {
  workspaceId: string;
  actorAdminUserId: string;
  routeId: string;
  indexingPolicy: "inherit" | "index" | "noindex";
  sitemapIncluded: boolean;
  sitemapPriority?: number | null;
  sitemapChangefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never" | null;
}): Promise<RouteRow> {
  const { data, error } = await createServiceRoleClient().rpc("cms_update_route_discoverability", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorAdminUserId,
    p_route_id: params.routeId,
    p_indexing_policy: params.indexingPolicy,
    p_sitemap_included: params.sitemapIncluded,
    p_sitemap_priority: params.sitemapPriority ?? null,
    p_sitemap_changefreq: params.sitemapChangefreq ?? null,
  });
  if (error || !data) throw new Error(error?.message || "Could not update route discoverability");
  return data as RouteRow;
}

export async function deleteRoute(params: {
  workspaceId: string;
  actorAdminUserId: string;
  routeId: string;
}): Promise<{ ok: true }> {
  const db = createServiceRoleClient();
  const { error } = await db
    .from("content_routes")
    .delete()
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.routeId);

  if (error) throw new Error(error.message);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "routing.route.deleted",
    entityType: "route",
    entityId: params.routeId,
    metadata: {},
  });

  return { ok: true };
}

// Moved from app/api/routes/[id]/route.ts so the route has no direct queries.
export async function getRoute(workspaceId: string, routeId: string): Promise<RouteRow | null> {
  const { data } = await createServiceRoleClient()
    .from("content_routes")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", routeId)
    .maybeSingle();
  return (data as RouteRow) ?? null;
}
