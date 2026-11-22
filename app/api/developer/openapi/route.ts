import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { buildWorkspaceOpenApi } from "@/lib/developer/openapiService";
import { clientErrorMessage } from "@/lib/http/clientError";

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "workspace.manage" });
  if (auth.error) return auth.error;
  try {
    const data = await buildWorkspaceOpenApi(auth.data!.actor.workspaceId, new URL(req.url).origin);
    return NextResponse.json({ success: true, data, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error, "Could not build OpenAPI"), timestamp: new Date().toISOString() }, { status: 500 });
  }
}
