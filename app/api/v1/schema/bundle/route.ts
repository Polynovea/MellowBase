import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { apiSuccess } from "@/lib/developer/apiContract";
import { exportSchemaBundle } from "@/lib/developer/schemaDeliveryService";
import { filterSchemaBundle, tokenAccesses } from "@/lib/developer/items/legacy";

export async function GET(req:Request){const auth=await requireDeveloperApi(req,{scope:"schema.read"});if(auth.error)return auth.error;const url=new URL(req.url);const bundle=await exportSchemaBundle(auth.data!.workspaceId,url.searchParams.get("environment"));if(auth.data!.allowedModels.length)bundle.models=bundle.models.filter(m=>auth.data!.allowedModels.includes(m.apiKey));return apiSuccess(filterSchemaBundle(bundle,await tokenAccesses(auth.data!,bundle.models.map((m)=>m.apiKey),undefined,{fieldView:true})),{requestId:auth.data!.requestId,rateLimit:auth.data!.rateLimit});}
