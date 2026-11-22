// Supabase path of the navigation area (deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import { collectMenuRelations, findMenusUsingEntry, resolveNavigationItems } from "@/lib/navigation/navigationTree";
import type { NavigationItemData, NavigationMenuRow, NavigationVersionRow, ResolvedNavigationNode } from "@/lib/navigation/navigationService";

export async function listMenus(workspaceId: string): Promise<NavigationMenuRow[]> {
  const { data } = await createServiceRoleClient()
    .from("navigation_menus")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true });
  return (data as NavigationMenuRow[]) ?? [];
}

export async function getMenu(workspaceId: string, idOrKey: string): Promise<NavigationMenuRow | null> {
  const db = createServiceRoleClient();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrKey);

  let query = db.from("navigation_menus").select("*").eq("workspace_id", workspaceId);
  if (isUuid) {
    query = query.eq("id", idOrKey);
  } else {
    query = query.eq("key", idOrKey);
  }

  const { data } = await query.maybeSingle();
  return (data as NavigationMenuRow) ?? null;
}

export async function createMenu(params: {
  workspaceId: string;
  actorAdminUserId: string;
  key: string;
  name: string;
  description?: string | null;
  initialItems?: NavigationItemData[];
}): Promise<{ menu: NavigationMenuRow; version: NavigationVersionRow }> {
  const db = createServiceRoleClient();
  const key = params.key.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "_");

  const { data: menu, error: menuErr } = await db
    .from("navigation_menus")
    .insert({
      workspace_id: params.workspaceId,
      key,
      name: params.name.trim(),
      description: params.description?.trim() || null,
    })
    .select()
    .single();

  if (menuErr || !menu) throw new Error(menuErr?.message || "Could not create menu");

  // Create initial draft version 1
  const { data: version, error: vErr } = await db
    .from("navigation_menu_versions")
    .insert({
      workspace_id: params.workspaceId,
      menu_id: menu.id,
      version_number: 1,
      state: "draft",
      items_jsonb: params.initialItems || [],
      change_summary: "Initial menu structure",
      created_by: params.actorAdminUserId,
    })
    .select()
    .single();

  if (vErr || !version) throw new Error(vErr?.message || "Could not create initial menu version");

  await db
    .from("navigation_menus")
    .update({ current_draft_version_id: version.id })
    .eq("id", menu.id);

  if (params.initialItems && params.initialItems.length) {
    await syncMenuRelations(params.workspaceId, menu.id, params.initialItems);
  }

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "navigation.menu.created",
    entityType: "navigation_menu",
    entityId: menu.id,
    metadata: { key: menu.key, name: menu.name },
  });

  return {
    menu: { ...menu, current_draft_version_id: version.id } as NavigationMenuRow,
    version: version as NavigationVersionRow,
  };
}

/**
 * Synchronize generic dependency graph edges for a navigation menu.
 */
export async function syncMenuRelations(
  workspaceId: string,
  menuId: string,
  items: NavigationItemData[]
): Promise<void> {
  const db = createServiceRoleClient();

  const rows = collectMenuRelations(workspaceId, menuId, items);

  // Atomic stored procedure to maintain generic dependency graph edges without non-atomic fallback
  const { error } = await db.rpc("cms_replace_source_relations", {
    p_workspace_id: workspaceId,
    p_source_type: "menu",
    p_source_id: menuId,
    p_relations: rows,
  });
  if (error) {
    throw new Error(`Failed to replace navigation menu relations: ${error.message}`);
  }
}

export async function saveMenuDraft(params: {
  workspaceId: string;
  actorAdminUserId: string;
  menuId: string;
  items: NavigationItemData[];
  changeSummary?: string;
}): Promise<NavigationVersionRow> {
  const db = createServiceRoleClient();
  const menu = await getMenu(params.workspaceId, params.menuId);
  if (!menu) throw new Error("Menu not found");

  // Get highest version number
  const { data: latest } = await db
    .from("navigation_menu_versions")
    .select("version_number")
    .eq("workspace_id", params.workspaceId)
    .eq("menu_id", params.menuId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextVersionNumber = (latest?.version_number ?? 0) + 1;

  const { data: newVersion, error } = await db
    .from("navigation_menu_versions")
    .insert({
      workspace_id: params.workspaceId,
      menu_id: params.menuId,
      version_number: nextVersionNumber,
      state: "draft",
      items_jsonb: params.items,
      change_summary: params.changeSummary || `Draft update v${nextVersionNumber}`,
      created_by: params.actorAdminUserId,
    })
    .select()
    .single();

  if (error || !newVersion) throw new Error(error?.message || "Could not save menu draft");

  await db
    .from("navigation_menus")
    .update({ current_draft_version_id: newVersion.id, updated_at: new Date().toISOString() })
    .eq("id", params.menuId);

  await syncMenuRelations(params.workspaceId, params.menuId, params.items);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "navigation.menu.draft_saved",
    entityType: "navigation_menu",
    entityId: params.menuId,
    metadata: { versionNumber: nextVersionNumber },
  });

  return newVersion as NavigationVersionRow;
}

export async function publishMenu(params: {
  workspaceId: string;
  actorAdminUserId: string;
  menuId: string;
  versionNumber?: number;
}): Promise<NavigationVersionRow> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("cms_publish_navigation_menu", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorAdminUserId,
    p_menu_id: params.menuId,
    p_version_number: params.versionNumber ?? null,
  });

  if (error || !data) throw new Error(error?.message || "Could not publish navigation menu");

  const published = data as NavigationVersionRow;
  if (published.items_jsonb) {
    await syncMenuRelations(params.workspaceId, params.menuId, published.items_jsonb);
  }

  return published;
}

export async function listMenuVersions(workspaceId: string, menuId: string): Promise<NavigationVersionRow[]> {
  const { data } = await createServiceRoleClient()
    .from("navigation_menu_versions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("menu_id", menuId)
    .order("version_number", { ascending: false });
  return (data as NavigationVersionRow[]) ?? [];
}

/**
 * Resolves Navigation Tree for Website or Preview delivery:
 * 1. Loads draft or published version items.
 * 2. Resolves localized labels for the specified locale.
 * 3. Resolves internal canonical routes or entry URLs.
 * 4. Filters out items not matching the audience rule.
 */
export async function getResolvedNavigationTree(params: {
  workspaceId: string;
  menuKey: string;
  locale?: string;
  mode?: "preview" | "published";
  audience?: "all" | "authenticated" | "guest";
}): Promise<ResolvedNavigationNode[]> {
  const db = createServiceRoleClient();
  const menu = await getMenu(params.workspaceId, params.menuKey);
  if (!menu) return [];

  const versionId = params.mode === "preview" ? menu.current_draft_version_id || menu.published_version_id : menu.published_version_id;
  if (!versionId) return [];

  const { data: version } = await db
    .from("navigation_menu_versions")
    .select("items_jsonb")
    .eq("workspace_id", params.workspaceId)
    .eq("id", versionId)
    .single();

  if (!version || !Array.isArray(version.items_jsonb)) return [];

  const locale = params.locale || "en";
  const audience = params.audience || "all";

  // Preload routes in workspace for URL resolution
  const { data: routes } = await db
    .from("content_routes")
    .select("id, entry_id, path, locale, is_canonical")
    .eq("workspace_id", params.workspaceId)
    .neq("status", "archived");

  return resolveNavigationItems(version.items_jsonb, routes ?? [], locale, audience);
}

export async function getNavigationWhereUsed(workspaceId: string, entryId: string): Promise<{ menuId: string; menuKey: string; menuName: string }[]> {
  const db = createServiceRoleClient();
  const { data: versions } = await db
    .from("navigation_menu_versions")
    .select("menu_id, items_jsonb, navigation_menus!navigation_menu_versions_menu_id_workspace_id_fkey(id, key, name)")
    .eq("workspace_id", workspaceId);

  const menuVersions: Array<{ menu: { id: string; key: string; name: string }; items: NavigationItemData[] }> = [];
  for (const v of (versions ?? [])) {
    const menuObj = Array.isArray(v.navigation_menus) ? v.navigation_menus[0] : v.navigation_menus;
    if (menuObj && Array.isArray(v.items_jsonb)) {
      menuVersions.push({ menu: menuObj as { id: string; key: string; name: string }, items: v.items_jsonb });
    }
  }
  return findMenusUsingEntry(menuVersions, entryId);
}

// Moved from app/api/navigation/menus/[id]/route.ts so the route has no direct queries.
export async function updateMenuDetails(params: {
  workspaceId: string;
  menu: NavigationMenuRow;
  name?: string;
  description?: string | null;
}): Promise<void> {
  await createServiceRoleClient()
    .from("navigation_menus")
    .update({
      name: params.name ? params.name.trim() : params.menu.name,
      description: params.description !== undefined ? params.description?.trim() || null : params.menu.description,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.menu.id);
}

// Moved from app/api/navigation/menus/[id]/route.ts so the route has no direct queries.
export async function deleteMenu(params: { workspaceId: string; actorAdminUserId: string; menuId: string }): Promise<void> {
  const { error } = await createServiceRoleClient()
    .from("navigation_menus")
    .delete()
    .eq("workspace_id", params.workspaceId)
    .eq("id", params.menuId);
  if (error) throw new Error(error.message);

  await logPlatformEvent({
    workspaceId: params.workspaceId,
    actorAdminUserId: params.actorAdminUserId,
    action: "navigation.menu.deleted",
    entityType: "navigation_menu",
    entityId: params.menuId,
    metadata: {},
  });
}
