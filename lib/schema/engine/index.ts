// The schema engine: plans, renders and applies changes to per-model tables in the `content` schema.
// See plan.ts for the contract the migration runner builds on. The runner's adapter is
// { renderStep, computePlanHash, validatePlan, assertStageCurrent, applyStageBookkeeping }.
export * from "@/lib/schema/engine/plan";
export { canonicalJson, hashCanonical, hashModelSchema, hashShape } from "@/lib/schema/engine/hash";
export { KEY_PATTERN, COLUMN_NAME_PATTERN, STORAGE_COLUMNS, nameProblem, columnNameFor, tableNameCandidates, derivedName, assertIdentifier } from "@/lib/schema/engine/names";
export { DEFAULT_SCHEMA_LIMITS, SCHEMA_LIMIT_ENV, schemaLimitsFromEnv, type SchemaLimits } from "@/lib/schema/engine/limits";
export { columnForField, columnOfField, shapeForSchema, isLosslessTypeChange, FOREIGN_KEY_ACTIONS } from "@/lib/schema/engine/columns";
export { buildMigrationPlan, applyStepToShape, computePlanHash, type FieldRename, type PlanInput } from "@/lib/schema/engine/planner";
export { describeStep, describePlan, describeContextFor, confirmationPrompt, type DescribeContext } from "@/lib/schema/engine/describe";
export { renderStep, CONTENT_SCHEMA, type RenderOptions } from "@/lib/schema/engine/render";
export { countDestructiveImpact } from "@/lib/schema/engine/impact";
export { validatePlan, DATA_DELETING_STEPS } from "@/lib/schema/engine/validate";
export { SchemaEngineError, type SchemaEngineErrorCode } from "@/lib/schema/engine/errors";
export {
  applyDestructiveStage, applyExpandStage, applyStageBookkeeping, assertStageCurrent, chooseTableName, loadModelTable, loadReservedNames,
  prepareMigrationPlan, expectedConfirmation, NAME_RESERVATION_DAYS, type ExpandResult, type ModelTableState, type PrepareInput,
} from "@/lib/schema/engine/apply";
export { buildPlanFromTrustedState, assertRequestedPlan, type TrustedPlanInput } from "@/lib/schema/engine/trusted";
