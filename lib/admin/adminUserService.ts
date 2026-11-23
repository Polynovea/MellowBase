// Admin user profiles (the CMS's own user records, bound to the identity provider's user ID).
// Identity-provider calls (create, update and delete the auth user) stay in the routes until the
// built-in auth workstream.
import type { AdminRole } from "@/lib/admin/types";
import * as postgres from "@/lib/admin/adminUserService.postgres";

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


export const listAdminUsersWithActivity = postgres.listAdminUsersWithActivity;
export const findAdminUser = postgres.findAdminUser;
export const findProfileIdByAuthUserId = postgres.findProfileIdByAuthUserId;
export const createAdminProfile = postgres.createAdminProfile;
export const updateAdminProfile = postgres.updateAdminProfile;
export const updateOwnDisplayName = postgres.updateOwnDisplayName;
export const deleteAdminProfile = postgres.deleteAdminProfile;
