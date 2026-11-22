import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { getStorageProvider } from "@/lib/media/storageProvider";
import { assertCanonicalMediaFilename, assertMediaSignature } from "@/lib/media/uploadValidation";
import { clientErrorMessage } from "@/lib/http/clientError";
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { logPlatformEvent } from "@/lib/platform/audit";
import { isWorkspaceStorageKey } from "@/lib/media/storageKeys";
import { checkWorkspaceQuota } from "@/lib/media/uploadLimits";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_SIZE_BYTES = 10 * 1024 * 1024;
const ts = () => new Date().toISOString();

function safeSegment(value:string){return value.toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"")||"file";}

export async function POST(req: Request) {
  const auth=await requirePlatformAccess(req,{permission:"media.upload"});if(auth.error)return auth.error;
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const folder = safeSegment(String(formData.get("folder") || "general"));
    const environmentId=formData.get("environmentId")?String(formData.get("environmentId")):null;
    if (!(file instanceof File)) return NextResponse.json({ success:false,data:null,error:"No file provided",timestamp:ts() },{status:400});
    if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({success:false,data:null,error:`Unsupported file type: ${file.type}`,timestamp:ts()},{status:415});
    if (file.size > MAX_SIZE_BYTES) return NextResponse.json({success:false,data:null,error:"File exceeds 10 MB limit",timestamp:ts()},{status:413});
    const quota=await checkWorkspaceQuota(auth.data!.actor.workspaceId,file.size);
    if(!quota.ok)return NextResponse.json({success:false,data:null,error:quota.error,timestamp:ts()},{status:quota.status});
    const buffer=Buffer.from(await file.arrayBuffer());
    const ext=assertCanonicalMediaFilename(file.name,file.type);assertMediaSignature(buffer,file.type);
    const filename=`${auth.data!.actor.workspaceId}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const provider=await getStorageProvider({workspaceId:auth.data!.actor.workspaceId,environmentId});
    const uploaded=await provider.upload({body:buffer,key:filename,contentType:file.type});
    return NextResponse.json({success:true,data:{url:uploaded.url,filename,storageProvider:provider.key,storageConnectionId:provider.connectionId},error:null,timestamp:ts()},{status:201});
  } catch (err: unknown) {
    const message=clientErrorMessage(err);return NextResponse.json({success:false,data:null,error:message,timestamp:ts()},{status:500});
  }
}

export async function DELETE(req: Request) {
  const auth=await requirePlatformAccess(req,{permission:"media.upload"});if(auth.error)return auth.error;
  try {
    const { filename, storageProvider, environmentId } = await req.json();
    if (!filename) return NextResponse.json({success:false,data:null,error:"filename required",timestamp:ts()},{status:400});
    const workspaceId=auth.data!.actor.workspaceId;
    // Only objects this workspace uploaded, addressed by a clean relative key, may be removed here.
    if (!isWorkspaceStorageKey(workspaceId, filename)) return NextResponse.json({success:false,data:null,error:"filename is not a storage key owned by this workspace",timestamp:ts()},{status:403});
    // Registered assets have usage, replacement and audit history; they are retired through the asset API, never deleted raw.
    const {data:registered,error:lookupError}=await createServiceRoleClient().from("assets").select("id").eq("storage_key",filename).limit(1);
    if (lookupError) throw lookupError;
    if (registered?.length) return NextResponse.json({success:false,data:null,error:"This file is a registered asset; archive it from the media library instead",timestamp:ts()},{status:409});
    const provider=await getStorageProvider({workspaceId,environmentId:environmentId||null,storageProviderKey:storageProvider||null});
    await provider.remove(filename);
    await logPlatformEvent({workspaceId,actorAdminUserId:auth.data!.actor.adminUserId,action:"media.object.deleted",entityType:"storage_object",entityId:filename,metadata:{storageProvider:provider.key}});
    return NextResponse.json({success:true,data:null,error:null,timestamp:ts()});
  } catch (err: unknown) {
    const message=clientErrorMessage(err);return NextResponse.json({success:false,data:null,error:message,timestamp:ts()},{status:500});
  }
}
