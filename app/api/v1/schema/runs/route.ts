import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { apiError, apiSuccess } from "@/lib/developer/apiContract";
import { clientErrorMessage } from "@/lib/http/clientError";

export async function GET(req: Request) {
  const auth = await requireDeveloperApi(req, { scope: "schema.read" });
  if (auth.error) return auth.error;
  const meta = { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit };
  const { data, error } = await createServiceRoleClient()
    .from("developer_schema_runs")
    .select("id,operation,status,source_environment,target_environment,bundle_hash,summary_json,approval_note,created_at,completed_at")
    .eq("workspace_id", auth.data!.workspaceId)
    .order("created_at", { ascending: false })
    .limit(100);
  // A failed query must not look like "no runs yet".
  if (error) return apiError("SCHEMA_RUNS_READ_FAILED", clientErrorMessage(error, "Could not read schema run history"), 500, meta);
  return apiSuccess(data ?? [], meta);
}
