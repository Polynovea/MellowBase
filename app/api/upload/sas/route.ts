import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { getStorageProvider } from "@/lib/media/storageProvider";
import { assertCanonicalMediaFilename } from "@/lib/media/uploadValidation";
import { clientErrorMessage } from "@/lib/http/clientError";
import { checkWorkspaceQuota, parseDeclaredSize } from "@/lib/media/uploadLimits";

const ALLOWED_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
];
const ts=()=>new Date().toISOString();
function safeSegment(value:string){
  const cleaned=value.slice(0,200).toLowerCase().replace(/[^a-z0-9._-]+/g,"-");
  let start=0,end=cleaned.length;
  while(start<end&&cleaned[start]==="-")start++;
  while(end>start&&cleaned[end-1]==="-")end--;
  return cleaned.slice(start,end)||"file";
}

export async function POST(req: Request) {
  const auth=await requirePlatformAccess(req,{permission:"media.upload"});if(auth.error)return auth.error;
  try {
    const { folder="general", filename:rawName, contentType, environmentId, size }=await req.json();
    if(!rawName||!contentType)return NextResponse.json({success:false,data:null,error:"filename and contentType required",timestamp:ts()},{status:400});
    if(!ALLOWED_TYPES.includes(contentType))return NextResponse.json({success:false,data:null,error:`Unsupported type: ${contentType}`,timestamp:ts()},{status:415});
    const declared=parseDeclaredSize(size,contentType);
    if(!declared.ok)return NextResponse.json({success:false,data:null,error:declared.error,timestamp:ts()},{status:declared.status});
    const quota=await checkWorkspaceQuota(auth.data!.actor.workspaceId,declared.bytes);
    if(!quota.ok)return NextResponse.json({success:false,data:null,error:quota.error,timestamp:ts()},{status:quota.status});
    const ext=assertCanonicalMediaFilename(String(rawName),contentType);
    const filename=`${auth.data!.actor.workspaceId}/${safeSegment(String(folder))}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const provider=await getStorageProvider({workspaceId:auth.data!.actor.workspaceId,environmentId:environmentId||null});
    if(!provider.createPresignedUpload)return NextResponse.json({success:false,data:null,error:`${provider.kind} does not expose a direct presigned-upload contract; use the authenticated media upload endpoint instead.`,timestamp:ts()},{status:409});
    const {uploadUrl,readUrl}=await provider.createPresignedUpload(filename,contentType,declared.bytes);
    return NextResponse.json({success:true,data:{uploadUrl,readUrl,filename,storageProvider:provider.key,storageConnectionId:provider.connectionId},error:null,timestamp:ts()});
  }catch(err:unknown){const message=clientErrorMessage(err);return NextResponse.json({success:false,data:null,error:message,timestamp:ts()},{status:500});}
}
