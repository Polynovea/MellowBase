// Admin user profiles (the CMS's own user records, bound to the identity provider's user ID), with the
// backend dispatcher (the `admin` switch in POLYNOVEA_DATA_BACKEND). Identity-provider calls (create,
// update and delete the auth user) stay in the routes until the built-in auth workstream.
import { usesDirectPostgres } from "@/lib/db/backend";
import type { AdminRole } from "@/lib/admin/types";
import * as postgres from "@/lib/admin/adminUserService.postgres";
import * as supabase from "@/lib/admin/adminUserService.supabase";

export interface NewAdminProfile {
  auth_user_id: string;
  username: string;
  email: string;
  display_name: string;
  role: AdminRole;
  is_active: boolean;
  surface_access: string[];
  module_access: string[];
  module_write_access: string[];
  created_by: string;
}

export interface AdminProfilePatch {
  display_name: string;
  role: AdminRole;
  is_active: boolean;
  surface_access: string[];
  module_access: string[];
  module_write_access: string[];
  updated_at: string;
}

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("admin") ? direct : supabase);

export const listAdminUsersWithActivity: typeof supabase.listAdminUsersWithActivity = (...args) => impl().listAdminUsersWithActivity(...args);
export const findAdminUser: typeof supabase.findAdminUser = (...args) => impl().findAdminUser(...args);
export const findProfileIdByAuthUserId: typeof supabase.findProfileIdByAuthUserId = (...args) => impl().findProfileIdByAuthUserId(...args);
export const createAdminProfile: typeof supabase.createAdminProfile = (...args) => impl().createAdminProfile(...args);
export const updateAdminProfile: typeof supabase.updateAdminProfile = (...args) => impl().updateAdminProfile(...args);
export const updateOwnDisplayName: typeof supabase.updateOwnDisplayName = (...args) => impl().updateOwnDisplayName(...args);
export const deleteAdminProfile: typeof supabase.deleteAdminProfile = (...args) => impl().deleteAdminProfile(...args);
