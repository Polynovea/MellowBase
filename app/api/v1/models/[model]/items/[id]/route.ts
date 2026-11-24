// The generated items API: one item of one model (Phase 4). See lib/developer/items.
import { driftHeaders, itemsError, itemsOk, itemsRequest } from "@/lib/developer/items/http";
import { deleteItem, getItem, updateItem } from "@/lib/developer/items/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ model: string; id: string }> };

export async function GET(req: Request, { params }: Params) {
  const { model, id } = await params;
  const { ctx, api, error } = await itemsRequest(req, { scope: "content.read", modelApiKey: model });
  if (error) return error;
  try {
    const result = await getItem(ctx!, model, id, new URL(req.url).searchParams);
    return itemsOk({ data: result.item }, api!, result.schemaHash, 200, await driftHeaders(req, api!.workspaceId, result.view));
  } catch (failure) {
    return itemsError(failure, api!);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const { model, id } = await params;
  const { ctx, api, error } = await itemsRequest(req, { scope: "content.write", modelApiKey: model, write: true });
  if (error) return error;
  try {
    const body = await req.json().catch(() => Symbol.for("invalid"));
    const result = await updateItem(ctx!, model, id, body);
    return itemsOk({ data: result.item }, api!, result.schemaHash);
  } catch (failure) {
    return itemsError(failure, api!);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const { model, id } = await params;
  const { ctx, api, error } = await itemsRequest(req, { scope: "content.delete", modelApiKey: model, write: true });
  if (error) return error;
  try {
    await deleteItem(ctx!, model, id);
    return itemsOk({ data: null }, api!, "", 204);
  } catch (failure) {
    return itemsError(failure, api!);
  }
}
