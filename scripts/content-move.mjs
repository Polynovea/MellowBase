#!/usr/bin/env node
/**
 * Moves existing content into the model tables (self-hosted upgrade, phase 3).
 *
 *   npm run content:move -- --all                      every model: create missing tables (queued for the
 *                                                       schema worker), backfill, verify
 *   npm run content:move -- --all --switch             ...and switch each model whose run matched to read
 *                                                       from its table
 *   npm run content:move -- --model <id> [--switch]    one model (repeat --model for several)
 *   npm run content:move -- --rollback <id>            switch one model's reads back to the snapshots
 *   --workspace <id>   limit --all to one workspace
 *   --wait             wait for the schema worker to create missing tables, then continue
 *   --actor <id>       admin_users id recorded on the runs and switches
 *
 * Runs as the app login (POLYNOVEA_DATABASE_URL), never as the owner: it calls the content sync,
 * verify and read-switch functions (migration 0076) and the schema runner's request API. Table
 * creation is done by the schema worker (npm run worker:schema), which must be running for --wait.
 *
 * Output: one JSON line per model with its counts and checksum result. Never values or SQL. A model
 * whose table is part-way through a schema change (queued, running or failed) is reported as
 * `table_changing` with a plain-words `message`, and is not copied.
 * Exit code 1 if any model did not match (its reads stay on the snapshots).
 */
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const { getDb, closeDb } = await import("../lib/db/index.ts");
const move = await import("../lib/content/contentMove.ts");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const values = (flag) => args.flatMap((arg, i) => (arg === flag && UUID.test(args[i + 1] ?? "") ? [args[i + 1]] : []));
const has = (flag) => args.includes(flag);
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), job: "content-move", event, ...fields }));
// Failure fields for the JSON log lines (moveErrorFields in lib/content/contentMove.ts): kept
// deliberately, as this is an operator command's output, read by whoever runs it (no end user sees
// it). A SQLSTATE plus the SQL function's code word, a schema engine refusal with its plain-words
// message, or "error" with its type and a hint: never a bare "error", never values or SQL text.
// POLYNOVEA_DEBUG=1 also prints an unexpected error's message to stderr.
const failureFields = (error) => {
  const fields = move.moveErrorFields(error);
  if (fields.code === "error" && process.env.POLYNOVEA_DEBUG === "1") console.error(error);
  return fields;
};

const db = getDb();
const actor = values("--actor")[0] ?? null;
let failures = 0;

try {
  for (const modelId of values("--rollback")) {
    const model = await db.selectFrom("content_models").select(["id", "workspace_id"]).where("id", "=", modelId).executeTakeFirst();
    if (!model) { log("model_not_found", { modelId }); failures += 1; continue; }
    await move.setReadSource(db, { workspaceId: model.workspace_id, modelId, source: "snapshot", actor });
    log("rolled_back", { modelId, readSource: "snapshot" });
  }

  let query = db.selectFrom("content_models").select(["id", "workspace_id"]).orderBy("workspace_id").orderBy("id");
  const picked = values("--model");
  if (picked.length) query = query.where("id", "in", picked);
  else if (has("--all")) {
    const workspace = values("--workspace")[0];
    if (workspace) query = query.where("workspace_id", "=", workspace);
  } else query = query.where(() => false);
  const models = await query.execute();

  for (const model of models) {
    try {
      // A schema the engine cannot build a table for (saved around the CMS) is reported, not attempted.
      const problems = await move.modelSchemaProblems(db, { workspaceId: model.workspace_id, modelId: model.id });
      if (problems.length) {
        log("schema_invalid", { modelId: model.id, problems, message: move.describeSchemaProblems(problems) });
        failures += 1;
        continue;
      }
      let table = await move.ensureModelTable(db, { workspaceId: model.workspace_id, modelId: model.id, requestedBy: actor });
      // With --wait, wait for a queued table creation or a change part-way through, then look again.
      const waitFor = table.status === "requested" ? table.expandLedgerId : table.status === "change_in_progress" ? table.ledgerId : null;
      if (waitFor && has("--wait")) {
        const status = await move.waitForStage(db, waitFor);
        log("table_stage", { modelId: model.id, status });
        table = await move.ensureModelTable(db, { workspaceId: model.workspace_id, modelId: model.id, requestedBy: actor });
      }
      if (table.status !== "exists") {
        log(table.status === "change_in_progress" || table.status === "change_failed" ? "table_changing" : "table_pending", {
          modelId: model.id, status: table.status,
          ...(table.status === "change_in_progress" ? { ledgerId: table.ledgerId, stage: table.stage, stageStatus: table.stageStatus } : {}),
          ...(table.status === "change_failed" ? { ledgerId: table.ledgerId, errorRef: table.errorRef } : {}),
          message: move.describeTableStatus(table),
        });
        failures += 1;
        continue;
      }
      const result = await move.moveModel(db, { workspaceId: model.workspace_id, modelId: model.id, requestedBy: actor, switchReads: has("--switch") });
      if (result.table.status !== "exists") {
        log("table_changing", { modelId: model.id, status: result.table.status, message: move.describeTableStatus(result.table) });
        failures += 1;
        continue;
      }
      const run = result.verify ? await move.moveRun(db, result.verify.runId) : null;
      log("model_moved", {
        modelId: model.id,
        batches: result.backfill?.batches, entries: result.backfill?.entries, synced: result.backfill?.synced,
        failedEntries: result.backfill?.failed.length, retries: result.backfill?.retries, durationMs: result.backfill?.durationMs,
        runId: result.verify?.runId, matched: result.verify?.matched, mismatches: result.verify?.mismatches,
        counts: run?.counts, fields: run ? Object.keys(run.fields).length : undefined, switched: result.switched,
      });
      if (!result.verify?.matched) failures += 1;
    } catch (error) {
      failures += 1;
      // A change that reached the table while this run was copying (a column or the table is not
      // there): say so in plain words instead of the raw SQLSTATE.
      if (move.isTableShapeError(error)) {
        // Read-only look at the ledger (never queues anything from an error path).
        const change = await move.modelTableChange(db, model.id).catch(() => ({ state: "none" }));
        const table = move.tableStatusFromChange(change, "");
        log("table_changing", {
          modelId: model.id, ...failureFields(error), status: table?.status ?? "changed_during_run",
          message: table
            ? move.describeTableStatus(table)
            : "The model's table changed shape while content:move was copying (a schema change reached it). Nothing was switched; run content:move again.",
        });
      } else {
        log("model_failed", { modelId: model.id, ...failureFields(error) });
      }
    }
  }
} finally {
  await closeDb();
}
process.exit(failures ? 1 : 0);
