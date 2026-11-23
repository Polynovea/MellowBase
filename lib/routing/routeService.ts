// Routing area, route service: types.
//
// The queries run on PostgreSQL in routeService.postgres.ts.
import * as postgres from "@/lib/routing/routeService.postgres";

export { normalizePath } from "@/lib/routing/routePaths";

export interface RouteRow {
  id: string;
  workspace_id: string;
  parent_route_id: string | null;
  entry_id: string | null;
  locale: string;
  path: string;
  title: string | null;
  node_type: "routable_entry" | "virtual_folder" | "external_link" | "custom_path";
  is_canonical: boolean;
  status: "active" | "draft" | "archived";
  order_index: number;
  indexing_policy: "inherit" | "index" | "noindex";
  sitemap_included: boolean;
  sitemap_priority: number | null;
  sitemap_changefreq: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never" | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  children?: RouteRow[];
}

export interface RouteHistoryRow {
  id: string;
  workspace_id: string;
  route_id: string;
  entry_id: string | null;
  locale: string;
  old_path: string;
  new_path: string;
  changed_by: string | null;
  created_at: string;
}


export const checkPathCollision = postgres.checkPathCollision;
export const listRoutes = postgres.listRoutes;
export const getSiteTree = postgres.getSiteTree;
export const registerRoute = postgres.registerRoute;
export const syncRouteRelations = postgres.syncRouteRelations;
export const updateRoutePath = postgres.updateRoutePath;
export const updateRouteDiscoverability = postgres.updateRouteDiscoverability;
export const deleteRoute = postgres.deleteRoute;
export const getRoute = postgres.getRoute;
