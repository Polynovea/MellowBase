import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { getModel, getVersion, updateModelMetadata } from "@/lib/schema/modelService";
import { getDb } from "@/lib/db/index";
import { modelSchemaChanges } from "@/lib/schema/schemaChanges";
import { clientErrorMessage } from "@/lib/http/clientError";

const ts = () => new Date().toISOString();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAccess(req, { permission: "schema.read" });
  if (auth.error) return auth.error;

  const { id } = await params;
  const model = await getModel(auth.data!.actor.workspaceId, id);
  if (!model) return NextResponse.json({ success: false, data: null, error: "Not found", timestamp: ts() }, { status: 404 });
  // Phase 4: the model's schema changes still waiting, running or failed, each with its plan in plain
  // words (a deletion waiting for confirmation also says how many values it would delete).
  const version = await getVersion(model.id, model.current_schema_version);
  const schemaChanges = await modelSchemaChanges(getDb(), model, version?.schema_json ?? null).catch(() => []);
  return NextResponse.json({ success: true, data: { ...model, schemaChanges }, error: null, timestamp: ts() });
}

/**
 * Metadata only — description/icon/status. The model's name and fields
 * live in the canonical schema and only change through
 * /api/models/:id/apply-change's validate→diff→apply lifecycle, never a
 * silent PATCH, per the Phase 1 brief's explicit requirement.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAccess(req, { permission: "schema.manage" });
  if (auth.error) return auth.error;

  const { id } = await params;
  const model = await getModel(auth.data!.actor.workspaceId, id);
  if (!model) return NextResponse.json({ success: false, data: null, error: "Not found", timestamp: ts() }, { status: 404 });

  try {
    const body = await req.json();
    const patch: { description?: string; icon?: string; status?: string } = {};
    if (typeof body.description === "string") patch.description = body.description;
    if (typeof body.icon === "string") patch.icon = body.icon;
    if (body.status && ["draft", "active", "archived"].includes(body.status)) patch.status = body.status;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, data: null, error: "No updatable fields provided", timestamp: ts() }, { status: 400 });
    }
    let data;
    try {
      data = await updateModelMetadata(auth.data!.actor.workspaceId, model.id, { ...patch, updated_at: ts() });
    } catch (error) {
      return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error), timestamp: ts() }, { status: 500 });
    }
    return NextResponse.json({ success: true, data, error: null, timestamp: ts() });
  } catch (err: unknown) {
    const message = clientErrorMessage(err);
    return NextResponse.json({ success: false, data: null, error: message, timestamp: ts() }, { status: 400 });
  }
}
