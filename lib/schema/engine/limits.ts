// Per-install caps on what the schema engine will build. Defaults: 200 models, 150 fields per model,
// 50 indexes per model. The operator can change them with environment variables; anything that is not
// a positive whole number falls back to the default rather than lifting the cap.
//
// PostgreSQL also has a hard limit of 1,600 columns per table, and it counts deleted columns too: a
// dropped column keeps its slot until the table is rewritten. A model that has added and deleted many
// fields can therefore hit the limit with few live fields; the engine refuses to add more and the
// table needs a rebuild (a full copy into a fresh table) first.
export const POSTGRES_MAX_COLUMNS = 1_600;

export interface SchemaLimits {
  maxModels: number;
  maxFieldsPerModel: number;
  maxIndexesPerModel: number;
}

export const DEFAULT_SCHEMA_LIMITS: Readonly<SchemaLimits> = Object.freeze({
  maxModels: 200,
  maxFieldsPerModel: 150,
  maxIndexesPerModel: 50,
});

export const SCHEMA_LIMIT_ENV = {
  maxModels: "POLYNOVEA_SCHEMA_MAX_MODELS",
  maxFieldsPerModel: "POLYNOVEA_SCHEMA_MAX_FIELDS_PER_MODEL",
  maxIndexesPerModel: "POLYNOVEA_SCHEMA_MAX_INDEXES_PER_MODEL",
} as const satisfies Record<keyof SchemaLimits, string>;

/** PostgreSQL allows 1,600 columns per table; three are storage columns. */
const HARD_MAX_FIELDS = 1_500;
const HARD_MAX = 100_000;

function readLimit(raw: string | undefined, fallback: number, hardMax: number): number {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, hardMax) : fallback;
}

export function schemaLimitsFromEnv(env: Record<string, string | undefined> = process.env): SchemaLimits {
  return {
    maxModels: readLimit(env[SCHEMA_LIMIT_ENV.maxModels], DEFAULT_SCHEMA_LIMITS.maxModels, HARD_MAX),
    maxFieldsPerModel: readLimit(env[SCHEMA_LIMIT_ENV.maxFieldsPerModel], DEFAULT_SCHEMA_LIMITS.maxFieldsPerModel, HARD_MAX_FIELDS),
    maxIndexesPerModel: readLimit(env[SCHEMA_LIMIT_ENV.maxIndexesPerModel], DEFAULT_SCHEMA_LIMITS.maxIndexesPerModel, HARD_MAX),
  };
}
