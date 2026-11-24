// The generated items API: list and create items of one model (Phase 4). Generic handlers driven by
// the model's metadata; see lib/developer/items.
import { driftHeaders, itemsError, itemsOk, itemsRequest } from "@/lib/developer/items/http";
import { createItem, listItems } from "@/lib/developer/items/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ model: string }> };

export async function GET(req: Request, { params }: Params) {
  const { model } = await params;
  const { ctx, api, error } = await itemsRequest(req, { scope: "content.read", modelApiKey: model });
  if (error) return error;
  try {
    const result = await listItems(ctx!, model, new URL(req.url).searchParams);
    return itemsOk({ data: result.items, meta: { page: { limit: result.limit, nextCursor: result.nextCursor } } }, api!, result.schemaHash, 200, await driftHeaders(req, api!.workspaceId, result.view));
  } catch (failure) {
    return itemsError(failure, api!);
  }
}

export async function POST(req: Request, { params }: Params) {
  const { model } = await params;
  const { ctx, api, error } = await itemsRequest(req, { scope: "content.write", modelApiKey: model, write: true });
  if (error) return error;
  try {
    const body = await req.json().catch(() => Symbol.for("invalid"));
    const result = await createItem(ctx!, model, body, new URL(req.url).searchParams.get("locale") ?? undefined);
    return itemsOk({ data: result.item }, api!, result.schemaHash, 201);
  } catch (failure) {
    return itemsError(failure, api!);
  }
}
