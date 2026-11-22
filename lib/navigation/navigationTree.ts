// Pure navigation helpers shared by both data paths (moved unchanged out of navigationService.ts),
// so the Supabase and direct PostgreSQL implementations resolve trees and relations identically.
import type { NavigationItemData, ResolvedNavigationNode } from "@/lib/navigation/navigationService";

export interface MenuRelationRow {
  workspace_id: string;
  source_menu_id: string;
  source_entity_type: string;
  target_entity_type: string;
  relation_type: string;
  target_entry_id?: string | null;
  target_route_id?: string | null;
  target_asset_id?: string | null;
  target_term_id?: string | null;
  target_menu_id?: string | null;
}

/** The dependency graph edges a menu's items point at (entries, routes, assets, terms, sub-menus). */
export function collectMenuRelations(workspaceId: string, menuId: string, items: NavigationItemData[]): MenuRelationRow[] {
  const rows: MenuRelationRow[] = [];

  function collect(itemNodes: NavigationItemData[]) {
    for (const item of itemNodes) {
      if (item.targetEntryId) {
        rows.push({
          workspace_id: workspaceId,
          source_menu_id: menuId,
          source_entity_type: "menu",
          target_entity_type: "entry",
          relation_type: "menu_entry",
          target_entry_id: item.targetEntryId,
        });
      }
      if (item.targetRouteId) {
        rows.push({
          workspace_id: workspaceId,
          source_menu_id: menuId,
          source_entity_type: "menu",
          target_entity_type: "route",
          relation_type: "menu_route",
          target_route_id: item.targetRouteId,
        });
      }
      const assetId = item.targetAssetId || item.iconAssetId;
      if (assetId) {
        rows.push({
          workspace_id: workspaceId,
          source_menu_id: menuId,
          source_entity_type: "menu",
          target_entity_type: "asset",
          relation_type: "menu_icon",
          target_asset_id: assetId,
        });
      }
      if (item.targetTermId) {
        rows.push({
          workspace_id: workspaceId,
          source_menu_id: menuId,
          source_entity_type: "menu",
          target_entity_type: "term",
          relation_type: "menu_term",
          target_term_id: item.targetTermId,
        });
      }
      if (item.targetMenuId) {
        rows.push({
          workspace_id: workspaceId,
          source_menu_id: menuId,
          source_entity_type: "menu",
          target_entity_type: "menu",
          relation_type: "menu_submenu",
          target_menu_id: item.targetMenuId,
        });
      }
      if (item.children?.length) {
        collect(item.children);
      }
    }
  }

  collect(items);
  return rows;
}

export interface NavigationRouteRow {
  id: string;
  entry_id: string | null;
  path: string;
  locale: string;
  is_canonical: boolean;
}

/** Every entry and route ID a tree links to, so URL resolution loads only the routes it needs. */
export function referencedTargets(items: NavigationItemData[]): { entryIds: string[]; routeIds: string[] } {
  const entryIds = new Set<string>();
  const routeIds = new Set<string>();
  const walk = (nodes: NavigationItemData[]) => {
    for (const item of nodes) {
      if (item.itemType === "internal_entry" && item.targetEntryId) entryIds.add(item.targetEntryId);
      if (item.itemType === "internal_route" && item.targetRouteId) routeIds.add(item.targetRouteId);
      if (Array.isArray(item.children)) walk(item.children);
    }
  };
  walk(items);
  return { entryIds: [...entryIds], routeIds: [...routeIds] };
}

/**
 * Localized labels, route URLs and audience filtering for a menu version's items. For an entry with
 * several routes, a route in `locale` wins over the others, and among equals the later row wins.
 */
export function resolveNavigationItems(
  items: NavigationItemData[],
  routes: NavigationRouteRow[],
  locale: string,
  audience: "all" | "authenticated" | "guest",
): ResolvedNavigationNode[] {
  const routeByEntry = new Map<string, string>();
  const routeById = new Map<string, string>();
  for (const r of routes) {
    routeById.set(r.id, r.path);
    if (r.entry_id && (r.locale === locale || !routeByEntry.has(r.entry_id))) {
      routeByEntry.set(r.entry_id, r.path);
    }
  }

  function resolveItem(item: NavigationItemData): ResolvedNavigationNode | null {
    if (item.isVisible === false) return null;

    // Audience filtering
    const itemAudience = item.audienceRule || "all";
    if (itemAudience !== "all" && audience !== "all" && itemAudience !== audience) {
      return null;
    }

    // Localized label resolution
    let label = item.label;
    let url = item.url || "/";

    if (item.localizations && item.localizations.length) {
      const loc = item.localizations.find((l) => l.locale === locale);
      if (loc) {
        if (loc.label) label = loc.label;
        if (loc.urlOverride) url = loc.urlOverride;
      }
    }

    if (item.itemType === "internal_entry" && item.targetEntryId) {
      url = routeByEntry.get(item.targetEntryId) || `/entry/${item.targetEntryId}`;
    } else if (item.itemType === "internal_route" && item.targetRouteId) {
      url = routeById.get(item.targetRouteId) || url;
    }

    const children: ResolvedNavigationNode[] = [];
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        const resolvedChild = resolveItem(child);
        if (resolvedChild) children.push(resolvedChild);
      }
    }

    return {
      id: item.id,
      label,
      url,
      openInNewTab: Boolean(item.openInNewTab),
      audienceRule: itemAudience,
      children,
    };
  }

  const resolvedTree: ResolvedNavigationNode[] = [];
  for (const rootItem of items) {
    const resolved = resolveItem(rootItem);
    if (resolved) resolvedTree.push(resolved);
  }

  return resolvedTree;
}

/** The menus whose versions link to `entryId` anywhere in their item tree, once per menu. */
export function findMenusUsingEntry(
  versions: Array<{ menu: { id: string; key: string; name: string }; items: NavigationItemData[] }>,
  entryId: string,
): { menuId: string; menuKey: string; menuName: string }[] {
  const matchedMenus = new Map<string, { menuId: string; menuKey: string; menuName: string }>();

  function scanItems(items: NavigationItemData[], menu: { id: string; key: string; name: string }) {
    for (const it of items) {
      if (it.targetEntryId === entryId) {
        matchedMenus.set(menu.id, { menuId: menu.id, menuKey: menu.key, menuName: menu.name });
      }
      if (Array.isArray(it.children)) {
        scanItems(it.children, menu);
      }
    }
  }

  for (const v of versions) scanItems(v.items, v.menu);

  return Array.from(matchedMenus.values());
}
