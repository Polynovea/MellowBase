// Routing area, route service: types and the backend dispatcher.
//
// Each function runs on Supabase (routeService.supabase.ts) or directly on PostgreSQL
// (routeService.postgres.ts), chosen per call by the `routing` switch in POLYNOVEA_DATA_BACKEND.
// Both implementations keep the same signatures and return shapes, so the routes do not change.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/routing/routeService.postgres";
import * as supabase from "@/lib/routing/routeService.supabase";

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

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("routing") ? direct : supabase);

export const checkPathCollision: typeof supabase.checkPathCollision = (...args) => impl().checkPathCollision(...args);
export const listRoutes: typeof supabase.listRoutes = (...args) => impl().listRoutes(...args);
export const getSiteTree: typeof supabase.getSiteTree = (...args) => impl().getSiteTree(...args);
export const registerRoute: typeof supabase.registerRoute = (...args) => impl().registerRoute(...args);
export const syncRouteRelations: typeof supabase.syncRouteRelations = (...args) => impl().syncRouteRelations(...args);
export const updateRoutePath: typeof supabase.updateRoutePath = (...args) => impl().updateRoutePath(...args);
export const updateRouteDiscoverability: typeof supabase.updateRouteDiscoverability = (...args) => impl().updateRouteDiscoverability(...args);
export const deleteRoute: typeof supabase.deleteRoute = (...args) => impl().deleteRoute(...args);
export const getRoute: typeof supabase.getRoute = (...args) => impl().getRoute(...args);
