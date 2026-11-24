import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { apiError, apiSuccess } from "@/lib/developer/apiContract";
import { exportWorkspaceData } from "@/lib/developer/exportService";
import { clientErrorMessage } from "@/lib/http/clientError";
import { getDb } from "@/lib/db/index";
import { bypassesFieldRules } from "@/lib/developer/items/access";
import { principalForToken } from "@/lib/developer/items/principal";

export async function GET(req:Request){const auth=await requireDeveloperApi(req,{scope:["content.read","schema.read","media.read","releases.read"]});if(auth.error)return auth.error;if(auth.data!.allowedModels.length)return apiError("MODEL_RESTRICTED","Full workspace export requires a token without model restrictions",403,{requestId:auth.data!.requestId,rateLimit:auth.data!.rateLimit});try{const principal=await principalForToken(getDb(),auth.data!);if(!bypassesFieldRules(principal))return apiError("EXPORT_REQUIRES_OWNER","Full workspace export includes every field of every entry, so it needs a token acting as the workspace owner",403,{requestId:auth.data!.requestId,rateLimit:auth.data!.rateLimit});return apiSuccess(await exportWorkspaceData(auth.data!.workspaceId),{requestId:auth.data!.requestId,rateLimit:auth.data!.rateLimit});}catch(e){return apiError("EXPORT_FAILED",clientErrorMessage(e, "Could not export workspace"),500,{requestId:auth.data!.requestId,rateLimit:auth.data!.rateLimit});}}
