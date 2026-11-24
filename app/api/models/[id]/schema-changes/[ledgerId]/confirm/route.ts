import { NextResponse } from "next/server";
import { requirePlatformAccess } from "@/lib/platform/permissions";
import { getDb, withTransaction } from "@/lib/db/index";
import { getModel, getVersion } from "@/lib/schema/modelService";
import { confirmPlanStage } from "@/lib/schema/runner/request";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { modelSchemaChanges } from "@/lib/schema/schemaChanges";

const ts = () => new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string, status: number) => NextResponse.json({ success: false, data: null, error, timestamp: ts() }, { status });

/**
 * Confirms a model's waiting deletion stage: the admin types the model's API key (the Phase 3 rule
 * for destructive steps). Same permission as editing the model, with a recent sign-in (step-up); the
 * CSRF check comes with the admin session. The database checks the typed key and the confirming
 * admin's membership (polynovea_confirm_schema_stage); the schema worker then runs the stage. The
 * confirmation and its audit event commit together.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; ledgerId: string }> }) {
  const auth = await requirePlatformAccess(req, { permission: "schema.manage", stepUp: true });
  if (auth.error) return auth.error;
  const { id, ledgerId } = await params;
  const actor = auth.data!.actor;
  if (!UUID.test(ledgerId)) return fail("Change not found", 404);
  const model = await getModel(actor.workspaceId, id);
  if (!model) return fail("Not found", 404);

  const db = getDb();
  const stage = await db.selectFrom("schema_migration_ledger").select(["id", "stage", "status"])
    .where("id", "=", ledgerId).where("content_model_id", "=", model.id).where("workspace_id", "=", actor.workspaceId)
    .executeTakeFirst();
  if (!stage) return fail("Change not found", 404);
  if (stage.stage !== "destructive" || stage.status !== "awaiting_confirmation") return fail("This change is not waiting for a confirmation", 409);

  const body = await req.json().catch(() => null) as { typedApiKey?: unknown } | null;
  const typed = typeof body?.typedApiKey === "string" ? body.typedApiKey.trim() : "";
  if (!typed) return fail(`Type the model's API key (${model.api_key}) to confirm the deletion.`, 400);

  try {
    // The confirmation and its audit event commit together.
    await withTransaction(async (trx) => {
      await confirmPlanStage(trx, { ledgerId, confirmedBy: actor.adminUserId, typedApiKey: typed });
      await recordPlatformEvent(trx, {
        workspaceId: actor.workspaceId, actorAdminUserId: actor.adminUserId, action: "schema.migration.confirmed",
        entityType: "content_model", entityId: model.id, metadata: { ledgerId, stage: "destructive" },
      });
    });
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: string; message?: string };
    // 22023 is also raised when the confirming admin is not an active member of this workspace.
    if (code === "22023" && message === "schema_confirmation_unknown_user") return fail("Your account can't confirm changes in this workspace. Nothing was deleted.", 403);
    if (code === "22023") return fail(`That is not the model's API key (${model.api_key}). Nothing was deleted.`, 400);
    if (code === "55000") return fail("This change is not waiting for a confirmation", 409);
    if (code === "P0002") return fail("Change not found", 404);
    return fail("The deletion could not be confirmed. Try again.", 500);
  }
  // The deletion is confirmed from here on: a failure to read the changes back never turns that into
  // an error (the page reloads them; null tells it to).
  let schemaChanges: Awaited<ReturnType<typeof modelSchemaChanges>> | null = null;
  try {
    const version = await getVersion(model.id, model.current_schema_version);
    schemaChanges = await modelSchemaChanges(db, model, version?.schema_json ?? null, { countValues: true });
  } catch {
    schemaChanges = null;
  }
  return NextResponse.json({ success: true, data: { confirmed: true, schemaChanges }, error: null, timestamp: ts() });
}
