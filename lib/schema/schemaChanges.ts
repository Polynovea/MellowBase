/**
 * A model's schema changes as the CMS shows them (Phase 4): the stages still waiting, running or
 * failed, each with its plan in plain words. A deletion waiting for confirmation also carries how many
 * values it would delete (countDestructiveImpact, counted now) and the confirmation prompt. Reads only,
 * as the app role; confirming goes through confirmPlanStage (the database checks the typed api key).
 */
import type { DbExecutor } from "@/lib/db/index";
import { countDestructiveImpact } from "@/lib/schema/engine/impact";
import { confirmationPrompt, describeContextFor } from "@/lib/schema/engine/describe";
import type { MigrationPlan } from "@/lib/schema/engine/plan";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

export const OPEN_STATUSES = ["pending", "running", "awaiting_confirmation", "failed"] as const;

export interface SchemaChangeView {
  ledgerId: string;
  stage: "expand" | "destructive";
  status: string;
  createdAt: string;
  /** One plain sentence per step of this stage. Destructive steps include the values they delete. */
  plan: string[];
  /** Set for a deletion waiting for confirmation. */
  confirmation?: { prompt: string; valuesDeleted: number };
  /** A stable reference for support when the stage failed; never internals. */
  errorRef?: string | null;
}

interface LedgerRow {
  id: string;
  stage: string;
  status: string;
  created_at: string | Date;
  error_ref: string | null;
  plan_json: unknown;
}

function valuesDeleted(plan: MigrationPlan): number {
  return plan.steps
    .filter((step) => step.stage === "destructive")
    .reduce((sum, step) => sum + Number((step as { affectedValues?: number; affectedRows?: number }).affectedValues ?? (step as { affectedRows?: number }).affectedRows ?? 0), 0);
}

export async function modelSchemaChanges(
  db: DbExecutor,
  model: { id: string; workspace_id: string; name: string },
  currentSchema: CanonicalSchema | null,
): Promise<SchemaChangeView[]> {
  const rows = await db.selectFrom("schema_migration_ledger")
    .select(["id", "stage", "status", "created_at", "error_ref", "plan_json"])
    .where("content_model_id", "=", model.id).where("workspace_id", "=", model.workspace_id)
    .where("status", "in", [...OPEN_STATUSES])
    .orderBy("created_at", "desc").orderBy("stage").limit(10)
    .execute() as LedgerRow[];
  const views: SchemaChangeView[] = [];
  for (const row of rows) {
    let plan = row.plan_json as MigrationPlan | null;
    const stage = row.stage === "destructive" ? "destructive" : "expand";
    if (plan && stage === "destructive" && row.status === "awaiting_confirmation") {
      plan = await countDestructiveImpact(db, plan, describeContextFor(plan, model.name, [currentSchema]));
    }
    const steps = (plan?.steps ?? []).filter((step) => step.stage === stage);
    views.push({
      ledgerId: row.id,
      stage,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      plan: steps.map((step) => step.summary),
      ...(stage === "destructive" && row.status === "awaiting_confirmation" && plan
        ? { confirmation: { prompt: confirmationPrompt(plan.modelApiKey), valuesDeleted: valuesDeleted({ ...plan, steps }) } }
        : {}),
      ...(row.status === "failed" ? { errorRef: row.error_ref } : {}),
    });
  }
  return views;
}
