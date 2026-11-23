// TEST ONLY. Brings a model's table up to its current schema version the way production does it: the
// change is requested as the app role (requestSchemaChange), the migration worker process
// (scripts/schema-migration-worker.mjs, as the owner, the real engine and trusted rebuild) runs it, then
// the content is backfilled, verified and (optionally) the model's reads are switched to its table.
// The worker runs as its own process, so no code outside the runner imports its owner-side modules.
import { execFile } from "node:child_process";
import pg from "pg";
import { getDb } from "@/lib/db/index";
import { backfillModel, setReadSource, verifyModel, type BackfillResult, type VerifyResult } from "@/lib/content/contentMove";
import { TEST_LIMITS } from "@/lib/schema/engine/testing";
import { confirmPlanStage, requestSchemaChange } from "@/lib/schema/runner/request";

let session: pg.Client | null = null;

async function ownerSession(): Promise<pg.Client> {
  if (!session) {
    const url = process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL;
    if (!url) throw new Error("POLYNOVEA_TEST_POSTGRES_OWNER_URL is not set. Run node scripts/dev-db/setup.mjs, then npm run test:dual.");
    const client = new pg.Client({ connectionString: url, ssl: false });
    await client.connect();
    session = client;
  }
  return session;
}

export async function closeTableMoveSession(): Promise<void> {
  const client = session;
  session = null;
  await client?.end().catch(() => undefined);
}

/**
 * Runs the migration worker once for the model (`--once --model <id>`) and returns the final status of
 * each stage that was waiting. `contracts` also lets it contract finished renames and type changes;
 * `releaseId` is the worker's release (a newer one makes those contracts due).
 */
export async function runWorker(modelId: string, options: { contracts?: boolean; releaseId?: string } = {}): Promise<string[]> {
  const db = getDb();
  const waiting = await db.selectFrom("schema_migration_ledger").select("id").where("content_model_id", "=", modelId).where("status", "=", "pending").orderBy("created_at").execute();
  const env = {
    ...process.env,
    POLYNOVEA_MIGRATION_DATABASE_URL: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL,
    POLYNOVEA_SCHEMA_MAX_MODELS: String(TEST_LIMITS.maxModels),
    POLYNOVEA_RELEASE_ID: options.releaseId ?? "test-release",
  };
  const args = ["--loader", "./scripts/phase12_75-node-loader.mjs", "scripts/schema-migration-worker.mjs", "--once", "--model", modelId, ...(options.contracts ? ["--contracts"] : [])];
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, args, { env, cwd: process.cwd(), timeout: 280_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`schema worker exited with an error: ${String(stderr).slice(-400)}`));
      else resolve();
    });
  });
  if (!waiting.length) return [];
  const rows = await db.selectFrom("schema_migration_ledger").select(["id", "status"]).where("id", "in", waiting.map((row) => row.id)).execute();
  const status = new Map(rows.map((row) => [row.id, row.status]));
  return waiting.map((row) => status.get(row.id) ?? "unknown");
}

export interface BringUpResult {
  outcomes: string[];
  backfill: BackfillResult;
  verify: VerifyResult;
}

/**
 * Requests the change to the model's current version, runs it (confirming a destructive stage with the
 * model's api key, as a user would), backfills and verifies. With `switchReads`, switches the model's
 * reads to the table when the run matched.
 */
export async function bringModelTableUp(input: { workspaceId: string; modelId: string; actor: string | null; switchReads?: boolean }): Promise<BringUpResult> {
  const db = getDb();
  const model = await db.selectFrom("content_models as m")
    .innerJoin("content_model_versions as v", (join) => join.onRef("v.content_model_id", "=", "m.id").onRef("v.version_number", "=", "m.current_schema_version"))
    .select(["m.api_key", "v.id as version_id"]).where("m.id", "=", input.modelId).where("m.workspace_id", "=", input.workspaceId)
    .executeTakeFirstOrThrow();
  const outcomes: string[] = [];
  const table = await db.selectFrom("content_model_tables").select("applied_version_id").where("content_model_id", "=", input.modelId).executeTakeFirst();
  if (!table || table.applied_version_id !== model.version_id) {
    const request = await requestSchemaChange(db, { contentModelId: input.modelId, targetVersionId: model.version_id, requestedBy: input.actor, limits: TEST_LIMITS });
    outcomes.push(...await runWorker(input.modelId));
    if (request.destructiveLedgerId) {
      // Confirming needs an active member of the workspace, as in the CMS.
      if (input.actor) {
        await (await ownerSession()).query(
          "insert into workspace_members (workspace_id, admin_user_id, status) values ($1, $2, 'active') on conflict do nothing", [input.workspaceId, input.actor]);
      }
      await confirmPlanStage(db, { ledgerId: request.destructiveLedgerId, confirmedBy: input.actor, typedApiKey: model.api_key });
      outcomes.push(...await runWorker(input.modelId));
    }
  }
  const backfill = await backfillModel(db, { workspaceId: input.workspaceId, modelId: input.modelId });
  const verify = await verifyModel(db, { workspaceId: input.workspaceId, modelId: input.modelId, requestedBy: input.actor, backfill });
  if (input.switchReads && verify.matched) await setReadSource(db, { workspaceId: input.workspaceId, modelId: input.modelId, source: "table", actor: input.actor });
  return { outcomes, backfill, verify };
}
