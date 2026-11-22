// Pure routing helpers shared by both data paths (moved unchanged out of routeService.ts).
import type { RouteRow } from "@/lib/routing/routeService";

export const RESERVED_PREFIXES = ["/admin", "/api", "/preview", "/auth", "/_next", "/favicon.ico", "/robots.txt", "/sitemap.xml"];

/**
 * Hardened Path Normalization Policy:
 * 1. Leading slash: ALWAYS required
 * 2. Trailing slash: ALWAYS stripped (except root "/")
 * 3. Case policy: ALWAYS lowercased
 * 4. Duplicate slashes: ALWAYS collapsed
 * 5. Query strings / fragments: FORBIDDEN
 * 6. Reserved system prefixes: FORBIDDEN
 */
export function normalizePath(rawPath: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!rawPath || typeof rawPath !== "string") {
    return { ok: false, error: "Path cannot be empty" };
  }

  let trimmed = rawPath.trim();
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return { ok: false, error: "URL path cannot contain query parameters or fragments" };
  }

  // Ensure leading slash
  if (!trimmed.startsWith("/")) {
    trimmed = `/${trimmed}`;
  }

  // Collapse duplicate slashes and lowercase
  let normalized = trimmed.replace(/\/+/g, "/").toLowerCase();

  // Strip trailing slash unless root
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  // Check reserved system prefixes
  for (const prefix of RESERVED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return { ok: false, error: `Path '${normalized}' uses a reserved system prefix (${prefix})` };
    }
  }

  // Slug segment validation: allow a-z, 0-9, -, _, ., /
  if (!/^\/[a-z0-9_.\-\/]*$/.test(normalized)) {
    return { ok: false, error: "Path contains invalid characters (only alphanumeric, dashes, dots and slashes allowed)" };
  }

  return { ok: true, path: normalized };
}


export interface RouteRelationRow {
  workspace_id: string;
  source_route_id: string;
  source_entity_type: string;
  target_entity_type: string;
  relation_type: string;
  target_entry_id?: string | null;
  target_term_id?: string | null;
  target_asset_id?: string | null;
  target_route_id?: string | null;
  target_menu_id?: string | null;
}

/** The dependency graph edges a route points at: its entry, plus targets named in its metadata. */
export function collectRouteRelations(
  workspaceId: string,
  routeId: string,
  entryId?: string | null,
  metadata?: Record<string, unknown>,
): RouteRelationRow[] {
  const rows: RouteRelationRow[] = [];
  if (entryId) {
    rows.push({
      workspace_id: workspaceId,
      source_route_id: routeId,
      source_entity_type: "route",
      target_entity_type: "entry",
      relation_type: "route_entry",
      target_entry_id: entryId,
    });
  }

  const termId = (metadata?.targetTermId || metadata?.target_term_id || metadata?.termId) as string | undefined;
  if (termId) {
    rows.push({
      workspace_id: workspaceId,
      source_route_id: routeId,
      source_entity_type: "route",
      target_entity_type: "term",
      relation_type: "route_taxonomy",
      target_term_id: termId,
    });
  }

  const assetId = (metadata?.targetAssetId || metadata?.target_asset_id || metadata?.assetId) as string | undefined;
  if (assetId) {
    rows.push({
      workspace_id: workspaceId,
      source_route_id: routeId,
      source_entity_type: "route",
      target_entity_type: "asset",
      relation_type: "route_asset",
      target_asset_id: assetId,
    });
  }

  const targetRouteId = (metadata?.targetRouteId || metadata?.target_route_id) as string | undefined;
  if (targetRouteId) {
    rows.push({
      workspace_id: workspaceId,
      source_route_id: routeId,
      source_entity_type: "route",
      target_entity_type: "route",
      relation_type: "route_link",
      target_route_id: targetRouteId,
    });
  }

  const targetMenuId = (metadata?.targetMenuId || metadata?.target_menu_id || metadata?.menuId) as string | undefined;
  if (targetMenuId) {
    rows.push({
      workspace_id: workspaceId,
      source_route_id: routeId,
      source_entity_type: "route",
      target_entity_type: "menu",
      relation_type: "route_menu",
      target_menu_id: targetMenuId,
    });
  }

  return rows;
}

/** Nests routes under their parents; a route whose parent is not in the list becomes a root. */
export function buildRouteTree(routes: RouteRow[]): RouteRow[] {
  const routeMap = new Map<string, RouteRow>();

  for (const r of routes) {
    r.children = [];
    routeMap.set(r.id, r);
  }

  const rootNodes: RouteRow[] = [];
  for (const r of routes) {
    if (r.parent_route_id && routeMap.has(r.parent_route_id)) {
      routeMap.get(r.parent_route_id)!.children!.push(r);
    } else {
      rootNodes.push(r);
    }
  }

  return rootNodes;
}
