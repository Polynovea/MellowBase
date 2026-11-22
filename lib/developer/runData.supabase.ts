// Supabase path of the developer run records (moved from schemaDeliveryService.ts and
// importService.ts; deleted with the switch at the end of phase 1).
import { createServiceRoleClient } from "@/lib/admin/serviceRole";

/* eslint-disable @typescript-eslint/no-explicit-any -- run rows are passed through as before */
export async function insertSchemaRun(row: Record<string, unknown>): Promise<any> {
  const { data, error } = await createServiceRoleClient().from("developer_schema_runs").insert(row).select().single();
  if (error || !data) throw new Error(error?.message || "Could not record schema delivery run");
  return data;
}

export async function insertImportRun(row: Record<string, unknown>): Promise<any> {
  const { data: run, error: runError } = await createServiceRoleClient().from("developer_import_runs").insert(row).select().single();
  if (runError || !run) throw new Error(runError?.message || "Could not record import run");
  return run;
}

/** Best effort, as before: the import result is returned even if the run row could not be updated. */
export async function updateImportRun(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  await createServiceRoleClient().from("developer_import_runs").update(patch).eq("workspace_id", workspaceId).eq("id", runId);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
