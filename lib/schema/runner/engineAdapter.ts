// Wires the schema engine (phase 3 wave 1) into the runner for the worker process.
//
// Wave 1 has not pushed renderStep, the plan hash or the apply gates yet, so the worker refuses to
// start rather than run with anything else. When they land, this file imports them; nothing else in
// the runner changes.
import type { SchemaEngine } from "@/lib/schema/runner/engine";
import { RunnerError } from "@/lib/schema/runner/errors";

export function productionEngine(): SchemaEngine {
  throw new RunnerError("schema_engine_unavailable", "The schema engine's renderStep and apply gates are not available yet (phase 3 wave 1)");
}
