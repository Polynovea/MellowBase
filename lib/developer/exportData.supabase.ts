// Supabase path of the workspace export reads (moved unchanged from exportService.ts; deleted with
// the switch at the end of phase 1). PostgREST returns at most 1000 rows per read.
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- export rows are passed through as they are */
export async function rowsForWorkspace(table: string, workspaceId: string, select = "*"): Promise<any[]> {
  const { data, error } = await createServiceRoleClient().from(table).select(select).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Export failed for ${table}: ${error.message}`);
  return data ?? [];
}

export async function rowsByIds(table: string, column: string, ids: string[], select = "*"): Promise<any[]> {
  if (!ids.length) return [];
  const { data, error } = await createServiceRoleClient().from(table).select(select).in(column, ids);
  if (error) throw new Error(`Export failed for ${table}: ${error.message}`);
  return data ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function exportedWorkspace(workspaceId: string): Promise<{ id: string; slug: string; name: string; created_at: string | null; updated_at: string | null } | null> {
  const { data: workspace, error: workspaceError } = await createServiceRoleClient().from("workspaces").select("id,slug,name,created_at,updated_at").eq("id", workspaceId).maybeSingle();
  if (workspaceError) throw new Error(workspaceError.message);
  return workspace;
}
