import { NextResponse } from "next/server";
import * as routeData from "@/lib/http/routeData";
import { logAdminActivity } from "@/lib/admin/audit";
import { requireAdminRequest } from "@/lib/admin/serverAccess";
import { clientErrorMessage } from "@/lib/http/clientError";

const ts = () => new Date().toISOString();

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const forCategory = searchParams.get("for");

  try {
    const data = await routeData.listPlatforms(forCategory === "social" || forCategory === "ads" ? forCategory : null);
    return NextResponse.json({ success: true, data, error: null, timestamp: ts() });
  } catch (error) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error), timestamp: ts() }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireAdminRequest(req, { requiredWriteModule: "content.platforms" });
  if (auth.error) return auth.error;

  try {
    const body = await req.json();
    const name = String(body.name || "").trim();
    if (!name) {
      return NextResponse.json({ success: false, data: null, error: "Name is required", timestamp: ts() }, { status: 400 });
    }

    let data;
    try {
      data = await routeData.createPlatform({ name, for_social: body.for_social === undefined ? true : Boolean(body.for_social), for_ads: Boolean(body.for_ads) });
    } catch (error) {
      return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error), timestamp: ts() }, { status: 500 });
    }

    await logAdminActivity({
      actor: auth.data!.profile,
      action: "platform.create",
      targetType: "platform",
      targetId: data?.id ?? null,
      targetLabel: data?.name ?? name,
    });

    return NextResponse.json({ success: true, data, error: null, timestamp: ts() }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(err), timestamp: ts() }, { status: 400 });
  }
}
