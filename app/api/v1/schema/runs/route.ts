import * as routeData from "@/lib/http/routeData";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { apiError, apiSuccess } from "@/lib/developer/apiContract";
import { clientErrorMessage } from "@/lib/http/clientError";

export async function GET(req: Request) {
  const auth = await requireDeveloperApi(req, { scope: "schema.read" });
  if (auth.error) return auth.error;
  const meta = { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit };
  try {
    return apiSuccess(await routeData.schemaRuns(auth.data!.workspaceId), meta);
  } catch (error) {
    // A failed query must not look like "no runs yet".
    return apiError("SCHEMA_RUNS_READ_FAILED", clientErrorMessage(error, "Could not read schema run history"), 500, meta);
  }
}
