// Navigation area: types.
//
// The queries run on PostgreSQL in navigationService.postgres.ts.
import * as postgres from "@/lib/navigation/navigationService.postgres";

export interface NavigationMenuRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  description: string | null;
  current_draft_version_id: string | null;
  published_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NavigationItemData {
  id: string;
  label: string;
  itemType: "internal_entry" | "internal_route" | "external_url";
  targetEntryId?: string | null;
  targetRouteId?: string | null;
  targetAssetId?: string | null;
  iconAssetId?: string | null;
  targetTermId?: string | null;
  targetMenuId?: string | null;
  url?: string | null;
  openInNewTab?: boolean;
  audienceRule?: "all" | "authenticated" | "guest";
  orderIndex?: number;
  isVisible?: boolean;
  localizations?: { locale: string; label: string; urlOverride?: string | null }[];
  children?: NavigationItemData[];
}

export interface NavigationVersionRow {
  id: string;
  workspace_id: string;
  menu_id: string;
  version_number: number;
  state: "draft" | "published" | "archived";
  items_jsonb: NavigationItemData[];
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ResolvedNavigationNode {
  id: string;
  label: string;
  url: string;
  openInNewTab: boolean;
  audienceRule: "all" | "authenticated" | "guest";
  children: ResolvedNavigationNode[];
}


export const listMenus = postgres.listMenus;
export const getMenu = postgres.getMenu;
export const createMenu = postgres.createMenu;
export const syncMenuRelations = postgres.syncMenuRelations;
export const saveMenuDraft = postgres.saveMenuDraft;
export const publishMenu = postgres.publishMenu;
export const listMenuVersions = postgres.listMenuVersions;
export const getResolvedNavigationTree = postgres.getResolvedNavigationTree;
export const getNavigationWhereUsed = postgres.getNavigationWhereUsed;
export const updateMenuDetails = postgres.updateMenuDetails;
export const deleteMenu = postgres.deleteMenu;
