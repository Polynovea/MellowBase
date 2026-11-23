import { apiError, apiSuccess } from "@/lib/developer/apiContract";
import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { installExtension, registerExtensionManifest } from "@/lib/developer/extensionGovernanceService";
import * as routeData from "@/lib/http/routeData";
import { clientErrorMessage } from "@/lib/http/clientError";

export async function GET(req: Request) {
  const auth = await requireDeveloperApi(req, { scope: "extension.read" });
  if (auth.error) return auth.error;
  try {
    return apiSuccess(await routeData.extensionInstallations(auth.data!.workspaceId), { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit });
  } catch (error) {
    return apiError("EXTENSION_LIST_FAILED", clientErrorMessage(error), 500, { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit });
  }
}

export async function POST(req: Request) {
  let body: any; try { body = await req.json(); } catch { return apiError("INVALID_REQUEST", "Request body must be JSON", 400); }
  const auth = await requireDeveloperApi(req, { scope: "extension.manage", requireActor: true });
  if (auth.error) return auth.error;
  try {
    const result = body.operation === "register"
      ? await registerExtensionManifest({ workspaceId: auth.data!.workspaceId, actorId: auth.data!.actorAdminUserId!, input: body.manifest })
      : body.operation === "install"
        ? await installExtension({ workspaceId: auth.data!.workspaceId, actorId: auth.data!.actorAdminUserId!, manifestId: String(body.manifestId), grantedPermissions: Array.isArray(body.grantedPermissions) ? body.grantedPermissions.map(String) : [], grantedNetwork: Array.isArray(body.grantedNetwork) ? body.grantedNetwork.map(String) : [], grantedConnections: Array.isArray(body.grantedConnections) ? body.grantedConnections : [], configuration: body.configuration && typeof body.configuration === "object" ? body.configuration : {} })
        : null;
    if (!result) return apiError("UNSUPPORTED_OPERATION", "operation must be register or install", 400, { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit });
    return apiSuccess(result, { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit });
  } catch (error: any) { return apiError("EXTENSION_OPERATION_FAILED", clientErrorMessage(error, "Extension operation failed"), Number(error?.status) || 400, { requestId: auth.data!.requestId, rateLimit: auth.data!.rateLimit }); }
}
