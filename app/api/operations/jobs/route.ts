import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { listDeliveryJobs, type DeliveryJobKind, type DeliveryJobStatus } from "@/lib/operations/deliveryJobService";
import { clientErrorMessage } from "@/lib/http/clientError";

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "content.entry.read" });
  if (auth.error) return auth.error;
  try {
    const url = new URL(req.url);
    const data = await listDeliveryJobs({
      workspaceId: auth.data!.actor.workspaceId,
      status: (url.searchParams.get("status") || undefined) as DeliveryJobStatus | undefined,
      kind: (url.searchParams.get("kind") || undefined) as DeliveryJobKind | undefined,
      correlationId: url.searchParams.get("correlationId") || undefined,
      limit: Number(url.searchParams.get("limit") || 100),
    });
    return NextResponse.json({ success: true, data, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error, "Could not load delivery jobs"), timestamp: new Date().toISOString() }, { status: 400 });
  }
}
