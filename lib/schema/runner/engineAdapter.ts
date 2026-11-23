// Wires the schema engine (phase 3 wave 1) into the runner for the worker process: the runner never
// renders SQL, hashes plans or records shapes itself.
import {
  applyStageBookkeeping, assertStageCurrent, computePlanHash, renderStep, schemaLimitsFromEnv, validatePlan, type SchemaLimits,
} from "@/lib/schema/engine";
import type { SchemaEngine } from "@/lib/schema/runner/engine";

export function productionEngine(limits: SchemaLimits = schemaLimitsFromEnv()): SchemaEngine {
  return {
    // Indexes CONCURRENTLY (the engine's default for the runner).
    renderStep: (step) => renderStep(step),
    computePlanHash,
    validatePlan: (plan, options) => validatePlan(plan, { limits: options?.limits ?? limits }),
    assertStageCurrent: (trx, plan, stage, options) => assertStageCurrent(trx, plan, stage, { limits: options?.limits ?? limits }),
    applyStageBookkeeping,
  };
}
