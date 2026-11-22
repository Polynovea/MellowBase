// Navigation area: types and the backend dispatcher.
//
// Each function runs on Supabase (navigationService.supabase.ts) or directly on PostgreSQL
// (navigationService.postgres.ts), chosen per call by POLYNOVEA_DATA_BACKEND (see lib/db/backend.ts).
// Both implementations keep the same signatures and return shapes, so the routes do not change.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/navigation/navigationService.postgres";
import * as supabase from "@/lib/navigation/navigationService.supabase";

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

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("navigation") ? direct : supabase);

export const listMenus: typeof supabase.listMenus = (...args) => impl().listMenus(...args);
export const getMenu: typeof supabase.getMenu = (...args) => impl().getMenu(...args);
export const createMenu: typeof supabase.createMenu = (...args) => impl().createMenu(...args);
export const syncMenuRelations: typeof supabase.syncMenuRelations = (...args) => impl().syncMenuRelations(...args);
export const saveMenuDraft: typeof supabase.saveMenuDraft = (...args) => impl().saveMenuDraft(...args);
export const publishMenu: typeof supabase.publishMenu = (...args) => impl().publishMenu(...args);
export const listMenuVersions: typeof supabase.listMenuVersions = (...args) => impl().listMenuVersions(...args);
export const getResolvedNavigationTree: typeof supabase.getResolvedNavigationTree = (...args) => impl().getResolvedNavigationTree(...args);
export const getNavigationWhereUsed: typeof supabase.getNavigationWhereUsed = (...args) => impl().getNavigationWhereUsed(...args);
export const updateMenuDetails: typeof supabase.updateMenuDetails = (...args) => impl().updateMenuDetails(...args);
export const deleteMenu: typeof supabase.deleteMenu = (...args) => impl().deleteMenu(...args);
