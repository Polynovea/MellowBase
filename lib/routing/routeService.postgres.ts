// PostgreSQL implementation of the routing area's route service (phase 1, wave 1).
//
// Deliberate differences from the Supabase path it replaced in phase 1:
// - Registering a route (un-canonicalizing the entry's other routes, the insert, its dependency
// edges and the audit row) is one transaction. The Supabase path cleared the old canonical flag
// first and could then fail the insert, leaving the entry with no canonical route.
// - A path change and its dependency edges commit together, as does a delete and its audit row.
// - A collision check that finds more than one conflicting route reports a collision. The Supabase
// path's .maybeSingle() errored on two rows and that error read as "no collision".
// - Malformed IDs in reads behave as "not found", as they did over PostgREST; every list query
// has an explicit limit and every statement is scoped by workspace_id.
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, withTransaction, type DbExecutor } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { buildRouteTree, collectRouteRelations, normalizePath } from "@/lib/routing/routePaths";
import type { RouteRow } from "@/lib/routing/routeService";

const LIST_LIMIT = DEFAULT_LIST_LIMIT;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

// Numeric and jsonb columns come back as numbers and objects (lib/db/pool.ts), as over PostgREST.
const asRoute = (row: unknown) => row as RouteRow;

async function findCollision(executor: DbExecutor, workspaceId: string, locale: string, path: string, excludeRouteId?: string) {
  let query = executor
    .selectFrom("content_routes")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("locale", "=", locale)
    .where("path", "=", path)
    .where("status", "!=", "archived");
  if (excludeRouteId) {
    if (!isUuid(excludeRouteId)) return null; // PostgREST rejected the filter; the old path read that as no collision.
    query = query.where("id", "!=", excludeRouteId);
  }
  const rows = await query.orderBy("created_at").limit(1).execute();
  return rows[0] ? asRoute(rows[0]) : null;
}

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
  const conflict = await findCollision(getDb(), params.workspaceId, params.locale, norm.path, params.excludeRouteId);
  return { isCollision: Boolean(conflict), conflictingRoute: conflict, normalizedPath: norm.path };
}

export async function listRoutes(workspaceId: string, locale?: string): Promise<RouteRow[]> {
  let query = getDb()
    .selectFrom("content_routes")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("status", "!=", "archived");
  if (locale) query = query.where("locale", "=", locale);
  const rows = await query.orderBy("order_index", "asc").orderBy("path", "asc").limit(LIST_LIMIT).execute();
  return rows.map(asRoute);
}

export async function getSiteTree(workspaceId: string, locale: string = "en"): Promise<RouteRow[]> {
  return buildRouteTree(await listRoutes(workspaceId, locale));
}

async function replaceRouteRelations(executor: DbExecutor, workspaceId: string, routeId: string, entryId?: string | null, metadata?: Record<string, unknown>) {
  await callFunction("cms_replace_source_relations", {
    p_workspace_id: workspaceId,
    p_source_type: "route",
    p_source_id: routeId,
    // jsonb argument: serialized here, since the driver would send a JS array as a PostgreSQL array.
    p_relations: JSON.stringify(collectRouteRelations(workspaceId, routeId, entryId, metadata)),
  }, executor);
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
  const isCanonical = params.isCanonical ?? true;

  return withTransaction(async (trx) => {
    if (await findCollision(trx, params.workspaceId, params.locale, norm.path)) {
      throw new Error(`Route collision: path '${norm.path}' is already in use in locale '${params.locale}'`);
    }

    // If this is canonical for an entry, un-canonicalize any existing route for this entry/locale
    if (isCanonical && params.entryId) {
      await trx
        .updateTable("content_routes")
        .set({ is_canonical: false, updated_at: new Date().toISOString() })
        .where("workspace_id", "=", params.workspaceId)
        .where("entry_id", "=", params.entryId)
        .where("locale", "=", params.locale)
        .execute();
    }

    const route = asRoute(expectOne(await trx
      .insertInto("content_routes")
      .values({
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
        metadata_json: JSON.stringify(params.metadata || {}),
      })
      .returningAll()
      .execute(), "Could not create route"));

    await replaceRouteRelations(trx, params.workspaceId, route.id, route.entry_id, params.metadata);

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "routing.route.created",
      entityType: "route",
      entityId: route.id,
      metadata: { path: route.path, locale: route.locale, entryId: route.entry_id },
    });

    return route;
  });
}

/**
 * Synchronize generic dependency graph edges for a content route.
 */
export async function syncRouteRelations(
  workspaceId: string,
  routeId: string,
  entryId?: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await replaceRouteRelations(getDb(), workspaceId, routeId, entryId, metadata);
}

/**
 * Atomic Route Path Change: cms_update_route_path validates the new path, updates the route,
 * records the history row and the 301 redirect, and audits; the dependency edges follow in the
 * same transaction.
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

  return withTransaction(async (trx) => {
    const data = await callFunction("cms_update_route_path", {
      p_workspace_id: params.workspaceId,
      p_actor_id: params.actorAdminUserId,
      p_route_id: params.routeId,
      p_new_path: norm.path,
      p_title: params.title?.trim() || null,
      p_parent_route_id: params.parentRouteId !== undefined ? params.parentRouteId : null,
      p_order_index: params.orderIndex ?? null,
      p_parent_route_id_supplied: params.parentRouteId !== undefined,
    }, trx);
    if (!data) throw new Error("Could not update route path");

    const result = data as unknown as { route: RouteRow; redirectCreated: boolean };
    await replaceRouteRelations(trx, params.workspaceId, result.route.id, result.route.entry_id, result.route.metadata_json);
    return result;
  });
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
  const data = await callFunction("cms_update_route_discoverability", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorAdminUserId,
    p_route_id: params.routeId,
    p_indexing_policy: params.indexingPolicy,
    p_sitemap_included: params.sitemapIncluded,
    p_sitemap_priority: params.sitemapPriority ?? null,
    p_sitemap_changefreq: params.sitemapChangefreq ?? null,
  });
  if (!data) throw new Error("Could not update route discoverability");
  return asRoute(data);
}

export async function deleteRoute(params: {
  workspaceId: string;
  actorAdminUserId: string;
  routeId: string;
}): Promise<{ ok: true }> {
  if (!isUuid(params.routeId)) throw new Error("Invalid route ID");
  await withTransaction(async (trx) => {
    await trx
      .deleteFrom("content_routes")
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.routeId)
      .execute();
    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "routing.route.deleted",
      entityType: "route",
      entityId: params.routeId,
      metadata: {},
    });
  });
  return { ok: true };
}

export async function getRoute(workspaceId: string, routeId: string): Promise<RouteRow | null> {
  if (!isUuid(routeId)) return null;
  const rows = await getDb()
    .selectFrom("content_routes")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", routeId)
    .execute();
  return rows[0] ? asRoute(rows[0]) : null;
}
