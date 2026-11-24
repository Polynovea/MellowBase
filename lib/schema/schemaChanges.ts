/**
 * A model's schema changes as the CMS shows them (Phase 4): the stages still waiting, running or
 * failed, each with its plan in plain words. A deletion waiting for confirmation also carries the
 * confirmation prompt and, for callers who may confirm it, how many values it would delete
 * (countDestructiveImpact on the table's recorded shape, counted now, under a time limit). A count that
 * fails or runs out of time leaves that one change with its plain steps and no count; it never hides
 * the other changes. Reads only, as the app role; confirming goes through confirmPlanStage (the
 * database checks the typed api key).
 */
import { sql, type Kysely } from "kysely";
import type { DbExecutor } from "@/lib/db/index";
import type { DB } from "@/lib/db/generated/database";
import { countDestructiveImpact } from "@/lib/schema/engine/impact";
import { confirmationPrompt, describeContextFor } from "@/lib/schema/engine/describe";
import type { MigrationPlan, TableShape } from "@/lib/schema/engine/plan";
import type { CanonicalSchema } from "@/lib/schema/fields/types";

export const OPEN_STATUSES = ["pending", "running", "awaiting_confirmation", "failed"] as const;

export interface SchemaChangeView {
  ledgerId: string;
  stage: "expand" | "destructive";
  status: string;
  createdAt: string;
  /** One plain sentence per step of this stage. Destructive steps include the values they delete. */
  plan: string[];
  /**
   * Set for a deletion waiting for confirmation. `valuesDeleted` is null when it was not counted (the
   * caller may not confirm, or the count failed or ran out of time).
   */
  confirmation?: { prompt: string; valuesDeleted: number | null };
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

/** How long counting one waiting deletion may take before the page shows it without a count. */
const COUNT_TIMEOUT_MS = 5_000;

function valuesDeleted(plan: MigrationPlan): number | null {
  const counts = plan.steps
    .filter((step) => step.stage === "destructive")
    .map((step) => (step as { affectedValues?: number; affectedRows?: number }).affectedValues ?? (step as { affectedRows?: number }).affectedRows);
  return counts.some((count) => count === undefined) ? null : counts.reduce<number>((sum, count) => sum + Number(count), 0);
}

/** Counts under a statement time limit: in a transaction of its own unless `db` already is one. */
async function counted(db: DbExecutor, count: (trx: DbExecutor) => Promise<MigrationPlan>): Promise<MigrationPlan> {
  const run = async (trx: DbExecutor) => {
    await sql`select set_config('statement_timeout', ${String(COUNT_TIMEOUT_MS)}, true)`.execute(trx);
    return count(trx);
  };
  if (!db.isTransaction) return (db as Kysely<DB>).transaction().execute(run);
  // Inside the caller's transaction: a savepoint, so a failed count does not abort it.
  const savepoint = sql.raw("schema_change_count");
  await sql`savepoint ${savepoint}`.execute(db);
  try {
    const plan = await run(db);
    await sql`release savepoint ${savepoint}`.execute(db);
    return plan;
  } catch (error) {
    await sql`rollback to savepoint ${savepoint}`.execute(db);
    throw error;
  }
}

export async function modelSchemaChanges(
  db: DbExecutor,
  model: { id: string; workspace_id: string; name: string },
  currentSchema: CanonicalSchema | null,
  options: { countValues: boolean },
): Promise<SchemaChangeView[]> {
  const rows = await db.selectFrom("schema_migration_ledger")
    .select(["id", "stage", "status", "created_at", "error_ref", "plan_json"])
    .where("content_model_id", "=", model.id).where("workspace_id", "=", model.workspace_id)
    .where("status", "in", [...OPEN_STATUSES])
    .orderBy("created_at", "desc").orderBy("stage").limit(10)
    .execute() as LedgerRow[];
  const waiting = rows.some((row) => row.stage === "destructive" && row.status === "awaiting_confirmation");
  // The table as it is now: after the expand stage ran, renamed columns already have their new names.
  const live = waiting && options.countValues
    ? ((await db.selectFrom("content_model_tables").select("applied_shape").where("content_model_id", "=", model.id)
      .where("workspace_id", "=", model.workspace_id).executeTakeFirst())?.applied_shape as unknown as TableShape | undefined) ?? null
    : null;
  const views: SchemaChangeView[] = [];
  for (const row of rows) {
    let plan = row.plan_json as MigrationPlan | null;
    const stage = row.stage === "destructive" ? "destructive" : "expand";
    const awaiting = stage === "destructive" && row.status === "awaiting_confirmation";
    let countedNow = false;
    if (plan && awaiting && options.countValues && live) {
      const unCounted = plan;
      try {
        plan = await counted(db, (trx) => countDestructiveImpact(trx, unCounted, describeContextFor(unCounted, model.name, [currentSchema]), live));
        countedNow = true;
      } catch {
        // This change is shown with its plain steps and no count; the others are unaffected.
      }
    }
    const steps = (plan?.steps ?? []).filter((step) => step.stage === stage);
    views.push({
      ledgerId: row.id,
      stage,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      plan: steps.map((step) => step.summary),
      ...(awaiting && plan
        ? { confirmation: { prompt: confirmationPrompt(plan.modelApiKey), valuesDeleted: countedNow ? valuesDeleted({ ...plan, steps }) : null } }
        : {}),
      ...(row.status === "failed" ? { errorRef: row.error_ref } : {}),
    });
  }
  return views;
}
