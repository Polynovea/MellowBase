// Wires the schema engine (phase 3 wave 1) into the runner for the worker process: the runner never
// renders SQL, hashes plans or records shapes itself. (".../engine/index": the worker's module loader
// does not resolve a bare directory import.)
import {
  applyStageBookkeeping, assertStageCurrent, computePlanHash, renderStep, schemaLimitsFromEnv, validatePlan, type SchemaLimits,
} from "@/lib/schema/engine/index";
import type { SchemaEngine } from "@/lib/schema/runner/engine";
import { RunnerError } from "@/lib/schema/runner/errors";

export function productionEngine(limits: SchemaLimits = schemaLimitsFromEnv()): SchemaEngine {
  return {
    // Wave 1's buildPlanFromTrustedState is not merged yet. Until it is, the worker refuses every stage
    // rather than run a plan read from the app-writable ledger.
    buildPlanFromTrustedState: async () => {
      throw new RunnerError("trusted_plan_builder_unavailable");
    },
    // Wave 1's computeStageHash, likewise (agreed: each stage row holds its own stage's hash).
    computeStageHash: () => {
      throw new RunnerError("stage_hash_unavailable");
    },
    // Indexes CONCURRENTLY (the engine's default for the runner).
    renderStep: (step) => renderStep(step),
    computePlanHash,
    validatePlan: (plan, options) => validatePlan(plan, { limits: options?.limits ?? limits }),
    assertStageCurrent: (trx, plan, stage, options) => assertStageCurrent(trx, plan, stage, { limits: options?.limits ?? limits }),
    applyStageBookkeeping,
  };
}
