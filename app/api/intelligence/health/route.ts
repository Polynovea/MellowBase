import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { createRemediationTask, getContentHealth, queueContentHealthScan, scanContentHealth, updateContentHealthProfile } from "@/lib/content/healthService";
import { listModels } from "@/lib/schema/modelService";
import { canActorOperateModel } from "@/lib/schema/modelAccess";
import * as routeData from "@/lib/http/routeData";
import { clientErrorMessage } from "@/lib/http/clientError";

async function visibleEntryIds(actor: any) {
  const models = await listModels(actor.workspaceId);
  const allowedModels = new Set((await Promise.all(models.map(async (model) => ({ id: model.id, access: await canActorOperateModel(actor, model, "read") })))).filter((item) => item.access.allowed).map((item) => item.id));
  if (!allowedModels.size) return new Set<string>();
  return new Set(await routeData.entryIdsInModels(actor.workspaceId, [...allowedModels]));
}

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: "content.entry.read" });
  if (auth.error) return auth.error;
  try {
    const health = await getContentHealth(auth.data!.actor.workspaceId);
    const visible = await visibleEntryIds(auth.data!.actor);
    const canSeeAssets = auth.data!.actor.permissions.has("media.read");
    const include = (item: { entity_type: string; entity_id: string }) => item.entity_type === "entry" ? visible.has(item.entity_id) : canSeeAssets;
    const findings = health.findings.filter(include);
    const tasks = health.tasks.filter(include);
    const profiles = health.profiles.filter((profile) => visible.has(profile.entry_id));
    const visibleIds = [...visible];
    const searchDocs = await routeData.searchDocuments(auth.data!.actor.workspaceId, visibleIds);
    const profileByEntry = new Map(profiles.map((profile) => [profile.entry_id, profile]));
    const searchByEntry = new Map(searchDocs.map((row) => [row.entry_id, row]));
    const stewardship = visibleIds.map((entryId) => ({ entryId, search: searchByEntry.get(entryId) ?? null, profile: profileByEntry.get(entryId) ?? null }));
    const mayAssign = auth.data!.actor.permissions.has("content.entry.edit") || auth.data!.actor.permissions.has("workspace.manage");
    let members: Array<{ id: string; username: string; display_name: string | null; email: string }> = [];
    if (mayAssign) members = await routeData.activeMemberProfiles(auth.data!.actor.workspaceId);
    const open = findings.filter((item) => ["open", "acknowledged"].includes(item.state));
    const summary = {
      blocking: open.filter((item) => item.severity === "blocking").length,
      warnings: open.filter((item) => item.severity === "warning").length,
      info: open.filter((item) => item.severity === "info").length,
      openTasks: tasks.filter((item) => ["open", "in_progress"].includes(item.status)).length,
      missingOwner: open.filter((item) => item.finding_code === "missing_owner").length,
      overdueReview: open.filter((item) => ["review_overdue", "review_never_completed"].includes(item.finding_code)).length,
      expired: open.filter((item) => item.finding_code === "expired").length,
      staleLocales: open.filter((item) => item.finding_code === "localization_stale").length,
      unusedAssets: open.filter((item) => item.finding_code === "unused_asset").length,
      performanceDecline: open.filter((item) => item.finding_code === "performance_decline").length,
    };
    return NextResponse.json({ success: true, data: { ...health, findings, tasks, profiles, stewardship, members, currentActorId: auth.data!.actor.adminUserId, summary }, error: null });
  } catch (error) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error, "Could not load content health") }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: ["content.entry.edit", "workspace.manage"] });
  if (auth.error) return auth.error;
  try {
    const body = await req.json();
    const operation = String(body.operation || "");
    if (operation === "scan") {
      const data = await scanContentHealth({ workspaceId: auth.data!.actor.workspaceId, actorId: auth.data!.actor.adminUserId });
      return NextResponse.json({ success: true, data, error: null });
    }
    if (operation === "queue_scan") {
      const data = await queueContentHealthScan({ workspaceId: auth.data!.actor.workspaceId, actorId: auth.data!.actor.adminUserId });
      return NextResponse.json({ success: true, data, error: null }, { status: 202 });
    }
    if (operation === "update_profile") {
      const entryId = String(body.entryId || "");
      const access = await import("@/lib/schema/modelAccess").then(({ canActorOperateEntry }) => canActorOperateEntry(auth.data!.actor, entryId, "edit"));
      if (!access.allowed) return NextResponse.json({ success: false, data: null, error: access.error }, { status: access.status });
      const data = await updateContentHealthProfile({
        workspaceId: auth.data!.actor.workspaceId, actorId: auth.data!.actor.adminUserId, entryId,
        ownerId: body.ownerId ? String(body.ownerId) : null,
        reviewCadenceDays: body.reviewCadenceDays === null || body.reviewCadenceDays === undefined || body.reviewCadenceDays === "" ? null : Number(body.reviewCadenceDays),
        lastReviewedAt: body.lastReviewedAt ? String(body.lastReviewedAt) : null,
        expiresAt: body.expiresAt ? String(body.expiresAt) : null,
      });
      return NextResponse.json({ success: true, data, error: null });
    }
    if (operation === "create_task") {
      const data = await createRemediationTask({
        workspaceId: auth.data!.actor.workspaceId,
        actorId: auth.data!.actor.adminUserId,
        findingId: body.findingId ? String(body.findingId) : null,
        entityType: body.entityType === "asset" ? "asset" : "entry",
        entityId: String(body.entityId || ""),
        title: String(body.title || ""),
        priority: body.priority ? String(body.priority) : undefined,
        assignedTo: body.assignedTo ? String(body.assignedTo) : null,
        dueAt: body.dueAt ? String(body.dueAt) : null,
      });
      return NextResponse.json({ success: true, data, error: null }, { status: 201 });
    }
    return NextResponse.json({ success: false, data: null, error: "Unsupported content-health operation" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, data: null, error: clientErrorMessage(error, "Content-health operation failed") }, { status: 400 });
  }
}
