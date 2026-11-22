import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { listDestinationHealth } from "@/lib/operations/deliveryJobService";
import { clientErrorMessage } from "@/lib/http/clientError";

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "content.entry.read" });
  if (auth.error) return auth.error;
  try {
    const data = await listDestinationHealth(auth.data!.actor.workspaceId);
    return NextResponse.json({ success: true, data, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error, "Could not load destination health"), timestamp: new Date().toISOString() }, { status: 400 });
  }
}
