import { NextResponse } from "next/server";
import * as routeData from "@/lib/http/routeData";
import { platformPatch } from "@/lib/http/platformInput";
import { logAdminActivity } from "@/lib/admin/audit";
import { requireAdminRequest } from "@/lib/admin/serverAccess";
import { clientErrorMessage } from "@/lib/http/clientError";

const ts = () => new Date().toISOString();

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminRequest(req, { requiredWriteModule: "content.platforms" });
  if (auth.error) return auth.error;

  try {
    const { id } = await params;
    // Only the editable columns are taken from the body (it used to be spread into the update whole).
    const parsed = platformPatch(await req.json());
    if (!parsed.ok) return NextResponse.json({ success: false, data: null, error: parsed.error, timestamp: ts() }, { status: 400 });
    const body = parsed.patch;
    let data;
    try {
      data = await routeData.updatePlatform(id, body);
    } catch (error) {
      return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error), timestamp: ts() }, { status: 500 });
    }
    if (!data) return NextResponse.json({ success: false, data: null, error: "Platform not found", timestamp: ts() }, { status: 404 });

    await logAdminActivity({
      actor: auth.data!.profile,
      action: "platform.update",
      targetType: "platform",
      targetId: id,
      targetLabel: data?.name ?? null,
      details: body,
    });

    return NextResponse.json({ success: true, data, error: null, timestamp: ts() });
  } catch (err: any) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(err), timestamp: ts() }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminRequest(req, { requiredWriteModule: "content.platforms" });
  if (auth.error) return auth.error;

  try {
    const { id } = await params;
    try {
      await routeData.deletePlatform(id);
    } catch (error) {
      return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error), timestamp: ts() }, { status: 500 });
    }

    await logAdminActivity({
      actor: auth.data!.profile,
      action: "platform.delete",
      targetType: "platform",
      targetId: id,
    });

    return NextResponse.json({ success: true, data: null, error: null, timestamp: ts() });
  } catch (err: any) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(err), timestamp: ts() }, { status: 400 });
  }
}
