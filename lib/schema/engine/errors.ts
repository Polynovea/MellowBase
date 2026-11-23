// Refusals from the schema engine. Messages are plain words and safe to show (each carries a status).
// Plain TypeScript only (no parameter properties, enums or namespaces): the migration worker loads
// these files with Node's strip-only type removal.
export type SchemaEngineErrorCode =
  | "not_found" | "stale_plan" | "invalid_plan" | "confirmation_mismatch" | "stage_not_ready" | "reserved_name" | "cap_exceeded" | "apply_failed";

const STATUS: Record<SchemaEngineErrorCode, number> = {
  not_found: 404, stale_plan: 409, invalid_plan: 400, confirmation_mismatch: 400, stage_not_ready: 409, reserved_name: 409, cap_exceeded: 409, apply_failed: 500,
};

export class SchemaEngineError extends Error {
  readonly code: SchemaEngineErrorCode;
  readonly status: number;
  constructor(code: SchemaEngineErrorCode, message: string) {
    super(message);
    this.name = "SchemaEngineError";
    this.code = code;
    this.status = STATUS[code];
  }
}
