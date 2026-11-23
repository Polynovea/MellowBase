// Wires the schema engine (phase 3 wave 1) into the runner for the worker process: the runner never
// renders SQL, hashes plans, rebuilds plans or records shapes itself. (".../engine/index": the worker's
// module loader does not resolve a bare directory import.)
import {
  applyStageBookkeeping, assertRequestedPlan, assertStageCurrent, computePlanHash, renderStep, schemaLimitsFromEnv, validatePlan, type SchemaLimits,
} from "@/lib/schema/engine/index";
import type { SchemaEngine } from "@/lib/schema/runner/engine";

export function productionEngine(limits: SchemaLimits = schemaLimitsFromEnv()): SchemaEngine {
  return {
    rebuildRequestedPlan: (db, request) => assertRequestedPlan(db, { ...request, limits: request.limits ?? limits }),
    // Indexes CONCURRENTLY (the engine's default for the runner).
    renderStep: (step) => renderStep(step),
    computePlanHash,
    validatePlan: (plan, options) => validatePlan(plan, { limits: options?.limits ?? limits }),
    assertStageCurrent: (trx, plan, stage, options) => assertStageCurrent(trx, plan, stage, { limits: options?.limits ?? limits }),
    applyStageBookkeeping,
  };
}
