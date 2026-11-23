// The schema migration runner: applies one ledger stage at a time, as polynovea_owner.
//
// For each claimed stage (ledger.ts):
//   1. re-check the row from scratch (verify.ts); a refused row runs nothing;
//   2. refuse while an earlier stage of the model stopped halfway, and contract the model's pending
//      expand/contract tasks first;
//   3. the engine's gate: the model's applied shape must be the stage's starting shape;
//   4. run each step from where the run row says (execute.ts, expandContract.ts), logging its timings;
//   5. the engine's bookkeeping and "succeeded", in one transaction.
// Any error ends the stage as failed with a code (never SQL text or values). A failed stage keeps its
// position: setting its ledger row back to pending resumes it after the cause is fixed.
import type pg from "pg";
import { transactionOn, type SchemaEngine } from "@/lib/schema/runner/engine";
import { errorCode, RefusedError, RunnerError } from "@/lib/schema/runner/errors";
import { executeStep, inLockTimedTransaction, type RunnerHooks, type RunnerLog } from "@/lib/schema/runner/execute";
import { contractDue, runExpandStep } from "@/lib/schema/runner/expandContract";
import {
  claimNextStage, finishStep, markFailed, markSucceeded, openRun, unfinishedStageOf, unlockModel, tryLockModel,
} from "@/lib/schema/runner/ledger";
import type { LockRetryOptions } from "@/lib/schema/runner/lockRetry";
import { verifyLedgerRow, type LedgerRow } from "@/lib/schema/runner/verify";
import type { SchemaLimits } from "@/lib/schema/engine/limits";

export interface RunnerOptions {
  engine: SchemaEngine;
  workerId: string;
  releaseId: string;
  limits?: SchemaLimits;
  retry?: LockRetryOptions;
  hooks?: RunnerHooks;
  batchSize?: number;
  /** Lock wait for CONCURRENTLY statements (default 10 minutes; see lockRetry.ts). */
  concurrentLockTimeoutMs?: number;
  /** A second owner connection (the worker's pool) to report long CONCURRENTLY statements from outside. */
  observer?: Pick<pg.ClientBase, "query">;
  waitLogIntervalMs?: number;
  /** Structured log line: an event name and codes/ids only. */
  log?: RunnerLog;
  /** Roll a failed type change back at once (default true; see rollbackExpandTask). */
  rollbackFailedTypeChange?: boolean;
}

export type StageOutcome =
  | { ledgerId: string; outcome: "succeeded" }
  | { ledgerId: string; outcome: "failed" | "refused"; code: string };

/** Runs one claimed stage. `client` is the session holding the model's advisory lock. */
export async function runClaimedStage(client: pg.ClientBase, row: LedgerRow, options: RunnerOptions): Promise<StageOutcome> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  let verified;
  try {
    verified = await verifyLedgerRow(client, row, options.engine, options.limits);
    if (await unfinishedStageOf(client, verified.plan.modelId, row.id)) throw new RefusedError("model_has_unfinished_stage");
  } catch (error) {
    const code = errorCode(error);
    await markFailed(client, row, options.workerId, code, true);
    log("stage_refused", { ledgerId: row.id, code });
    return { ledgerId: row.id, outcome: "refused", code };
  }

  const { plan, stage, steps } = verified;
  let runId: string | null = null;
  try {
    await contractDue({ client, retry: options.retry }, { releaseId: options.releaseId, modelId: plan.modelId, dueOnly: false, exceptLedgerId: row.id });
    const run = await openRun(client, row, options.workerId);
    runId = run.id;

    // The engine's gate, re-checked on every attempt (a resumed run has not changed the applied
    // shape). It locks the model's rows FOR UPDATE, so it gets a short transaction of its own: no
    // transaction stays open across the steps, CONCURRENTLY statements, backfill batches or sleeps.
    try {
      await inLockTimedTransaction(client, () => options.engine.assertStageCurrent(transactionOn(client), plan, stage, { limits: options.limits }), options.retry);
    } catch (error) {
      throw error instanceof RunnerError ? error : new RefusedError(errorCode(error) === "internal_error" ? "stage_not_current" : errorCode(error));
    }

    const context = {
      client, engine: options.engine, runId, table: plan.table, retry: options.retry, hooks: options.hooks, concurrentLockTimeoutMs: options.concurrentLockTimeoutMs,
      log, observer: options.observer, waitLogIntervalMs: options.waitLogIntervalMs,
    };
    for (let index = run.next_step; index < steps.length; index += 1) {
      const { planIndex, step } = steps[index];
      const stepStarted = new Date();
      const resumed = run.resumed && index === run.next_step;
      const result = step.kind === "rename_column" || step.kind === "change_type"
        ? await runExpandStep({ ...context, ledgerId: row.id, workspaceId: plan.workspaceId, modelId: plan.modelId, plan, releaseId: options.releaseId, batchSize: options.batchSize, rollbackFailedTypeChange: options.rollbackFailedTypeChange }, index, planIndex, step)
        : await executeStep(context, index, step, resumed ? run.next_statement : 0, resumed);
      await finishStep(client, run.id, {
        step: index, planIndex, kind: step.kind, startedAt: stepStarted.toISOString(), finishedAt: new Date().toISOString(),
        statements: result.statements, lockRetries: result.lockRetries,
      });
      log("step_done", { ledgerId: row.id, step: index, kind: step.kind, lockRetries: result.lockRetries });
    }

    // The final transaction: the gate once more, the engine's bookkeeping and "succeeded", together.
    // (Every step's own work committed already, with the run's position; a crash before this commit
    // resumes straight here.)
    await inLockTimedTransaction(client, async () => {
      const trx = transactionOn(client);
      await options.engine.assertStageCurrent(trx, plan, stage, { limits: options.limits });
      await options.engine.applyStageBookkeeping(trx, plan, stage);
      await markSucceeded(client, row.id, runId as string);
    }, options.retry);
    log("stage_succeeded", { ledgerId: row.id, stage, ms: Date.now() - started });
    return { ledgerId: row.id, outcome: "succeeded" };
  } catch (error) {
    const code = errorCode(error);
    const refused = error instanceof RefusedError;
    await client.query("rollback").catch(() => undefined);
    await markFailed(client, row, options.workerId, code, refused && runId === null);
    log("stage_failed", { ledgerId: row.id, code, ms: Date.now() - started });
    return { ledgerId: row.id, outcome: refused && runId === null ? "refused" : "failed", code };
  }
}

/** Claims and runs the next stage, if any. Returns its outcome, or null when nothing was waiting. */
export async function runNextStage(client: pg.ClientBase, options: RunnerOptions & { modelId?: string }): Promise<StageOutcome | null> {
  const claimed = await claimNextStage(client, { modelId: options.modelId });
  if (!claimed) return null;
  try {
    return await runClaimedStage(client, claimed.row, options);
  } finally {
    await unlockModel(client, claimed.modelId).catch(() => undefined);
  }
}

/** Contracts due expand/contract tasks, each under its model's lock (skipped while a stage runs). */
export async function runDueContracts(client: pg.ClientBase, options: Pick<RunnerOptions, "releaseId" | "retry" | "log"> & { now?: Date }): Promise<number> {
  const { rows } = await client.query<{ content_model_id: string }>(
    `select distinct content_model_id from public.schema_expand_contract_tasks
      where status = 'awaiting_contract' and content_model_id is not null
        and (contract_after <= $1 or (release_id is distinct from $2 and contract_min_at <= $1))`,
    [options.now ?? new Date(), options.releaseId],
  );
  let contracted = 0;
  for (const { content_model_id: modelId } of rows) {
    if (!(await tryLockModel(client, modelId))) continue;
    try {
      contracted += await contractDue({ client, retry: options.retry }, { releaseId: options.releaseId, modelId, dueOnly: true, now: options.now });
    } catch (error) {
      options.log?.("contract_failed", { modelId, code: errorCode(error) });
    } finally {
      await unlockModel(client, modelId).catch(() => undefined);
    }
  }
  return contracted;
}
