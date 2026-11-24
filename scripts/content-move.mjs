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
 * Output: one JSON line per model with its counts and checksum result. Never values or SQL.
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
const codeOf = (error) => (typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : "error") + (/^[a-z0-9_]{1,64}$/.test(String(error?.message)) ? `:${error.message}` : "");

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
      let table = await move.ensureModelTable(db, { workspaceId: model.workspace_id, modelId: model.id, requestedBy: actor });
      if (table.status === "requested" && table.expandLedgerId && has("--wait")) {
        const status = await move.waitForStage(db, table.expandLedgerId);
        log("table_stage", { modelId: model.id, status });
        table = await move.ensureModelTable(db, { workspaceId: model.workspace_id, modelId: model.id, requestedBy: actor });
      }
      if (table.status !== "exists") { log("table_pending", { modelId: model.id, status: table.status }); failures += 1; continue; }
      const result = await move.moveModel(db, { workspaceId: model.workspace_id, modelId: model.id, requestedBy: actor, switchReads: has("--switch") });
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
      log("model_failed", { modelId: model.id, code: codeOf(error) });
    }
  }
} finally {
  await closeDb();
}
process.exit(failures ? 1 : 0);
