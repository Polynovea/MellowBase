import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { searchContent } from "@/lib/content/searchService";
import { getModel, listModels } from "@/lib/schema/modelService";
import { canActorOperateModel } from "@/lib/schema/modelAccess";
import { getDb } from "@/lib/db/index";
import { adminAccesses } from "@/lib/developer/items/sideChannels";
import type { SearchFieldScope } from "@/lib/content/searchService";

/** Field permissions for search: the one permission function, for this admin (phase 4). */
async function searchFieldScope(workspaceId: string, adminUserId: string): Promise<SearchFieldScope> {
  const models = (await listModels(workspaceId)).filter((model) => model.status === "active");
  const accesses = await adminAccesses(getDb(), workspaceId, adminUserId, "admin", models.map((model) => model.api_key));
  const restricted = new Map<string, ReadonlySet<string>>();
  const readable = new Map<string, ReadonlySet<string>>();
  const readableModelIds: string[] = [];
  for (const access of accesses?.values() ?? []) {
    if (!access.canRead) continue;
    readableModelIds.push(access.model.id);
    readable.set(access.model.id, access.readable);
    if (access.restricted) restricted.set(access.model.id, access.readable);
  }
  return { restricted, readableModelIds, readable };
}

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "content.entry.read" });
  if (auth.error) return auth.error;
  const q = new URL(req.url).searchParams;
  const modelId = q.get("modelId") ?? undefined;
  if (modelId) {
    const model = await getModel(auth.data!.actor.workspaceId, modelId);
    if (!model) return NextResponse.json({ success: false, data: null, error: "Model not found" }, { status: 404 });
    const access = await canActorOperateModel(auth.data!.actor, model, "read");
    if (!access.allowed) return NextResponse.json({ success: false, data: null, error: access.error }, { status: access.status });
  }
  const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
  const offset = q.get("offset") ? Number(q.get("offset")) : undefined;
  const sortRaw = q.get("sort");
  const sort = sortRaw === "updated_asc" ? "updated_asc" : sortRaw === "updated_desc" ? "updated_desc" : "relevance";
  const fieldScope = await searchFieldScope(auth.data!.actor.workspaceId, auth.data!.actor.adminUserId);
  const documents = await searchContent({
    fieldScope,
    workspaceId: auth.data!.actor.workspaceId,
    query: q.get("q") ?? undefined,
    modelId,
    status: q.get("status") ?? undefined,
    locale: q.get("locale") ?? undefined,
    authorId: q.get("authorId") ?? undefined,
    updatedFrom: q.get("updatedFrom") ?? undefined,
    updatedTo: q.get("updatedTo") ?? undefined,
    termId: q.get("termId") ?? undefined,
    sort,
    limit,
    offset,
  });
  if (modelId) return NextResponse.json({ success: true, data: documents, error: null });
  const models = await listModels(auth.data!.actor.workspaceId);
  const allowed = new Set((await Promise.all(models.map(async (model) => ({ id: model.id, access: await canActorOperateModel(auth.data!.actor, model, "read") })))).filter(({ access }) => access.allowed).map(({ id }) => id));
  return NextResponse.json({ success: true, data: documents.filter((document: { content_model_id: string | null }) => document.content_model_id !== null && allowed.has(document.content_model_id)), error: null });
}
