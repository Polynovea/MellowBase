// Direct PostgreSQL path of the developer run records (phase 1, wave 2). The import-run update is
// also scoped by workspace_id, and its failure is logged instead of ignored (it stays best effort,
// as before).
import { expectOne, getDb } from "@/lib/db/index";

/* eslint-disable @typescript-eslint/no-explicit-any -- run rows are passed through as before */
/** jsonb values are serialized here; the driver would send a JS array as a PostgreSQL array. */
function withJson(row: Record<string, unknown>, jsonColumns: string[]): any {
  const out: Record<string, unknown> = { ...row };
  for (const column of jsonColumns) {
    if (out[column] !== undefined && out[column] !== null) out[column] = JSON.stringify(out[column]);
  }
  return out;
}

export async function insertSchemaRun(row: Record<string, unknown>): Promise<any> {
  return expectOne(await getDb().insertInto("developer_schema_runs").values(withJson(row, ["plan_json", "summary_json"])).returningAll().execute(), "Could not record schema delivery run");
}

export async function insertImportRun(row: Record<string, unknown>): Promise<any> {
  return expectOne(await getDb().insertInto("developer_import_runs").values(withJson(row, ["errors_json", "result_json"])).returningAll().execute(), "Could not record import run");
}

export async function updateImportRun(workspaceId: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await getDb().updateTable("developer_import_runs").set(withJson(patch, ["errors_json", "result_json"]))
      .where("workspace_id", "=", workspaceId).where("id", "=", runId).execute();
  } catch (error) {
    console.error("developer import run was not updated", { runId, error: error instanceof Error ? error.message : String(error) });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
