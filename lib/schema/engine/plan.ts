// The schema engine's migration plan: the hand-off contract between the planner (phase 3 wave 1) and
// the migration runner (wave 2). Types only; everything that builds, renders or applies a plan lives
// in the sibling modules and is re-exported from lib/schema/engine/index.ts.
//
// How the pieces fit:
// - A model's table is described by its TableShape: the columns it physically has now, with their
//   types and constraints. content_model_tables.applied_shape holds it; its hash is the
//   "schema the plan was built from".
// - buildMigrationPlan(currentShape, targetSchema) diffs the two and returns ordered steps. Steps are
//   logical ("add this column", "rename this column"); renderStep() turns one into SQL. The runner
//   may execute a step its own way (lock_timeout and retries, CONCURRENTLY, expand and contract) as
//   long as the end state matches the step.
// - Steps come in two stages. "expand" steps never delete data and run when the plan is applied.
//   "destructive" steps delete data, need the model's API key typed, and run as a separate, later step.
// - Applying a stage is refused unless the table's current shape hash equals the hash that stage was
//   planned from (baseShapeHash for expand, expandedShapeHash for destructive).
import type { RawBuilder } from "kysely";
import type { FieldType } from "@/lib/schema/fields/types";

/** Lowercase hex SHA-256 of canonical JSON (keys sorted at every depth). */
export type SchemaHash = string;

/** PostgreSQL column types a field can map to. Rendered from this fixed list, never from input. */
export const PG_COLUMN_TYPES = ["text", "jsonb", "numeric", "bigint", "boolean", "date", "timestamptz", "uuid"] as const;
export type PgColumnType = (typeof PG_COLUMN_TYPES)[number];

/** What happens to a row that links to an entry when that entry is deleted. */
export type ForeignKeyAction = "restrict" | "set_null";

/** One field's column, as it physically exists (or will). Index and constraint names derive from table + column. */
export interface ColumnShape {
  /** The physical column name (see columnNameFor): the field key when it fits, else derived. Fixed once chosen. */
  name: string;
  /** The field key this column stores. API, SDK and permissions use the key; only SQL uses `name`. */
  field: string;
  fieldType: FieldType;
  pgType: PgColumnType;
  /** CHECK (_variant <> 'published' OR col IS NOT NULL): drafts may be incomplete. */
  requiredWhenPublished: boolean;
  /** Unique index on (col, _variant, _locale). */
  unique: boolean;
  /** Plain index on col, for filtering and sorting (not created when `unique` already is). */
  indexed: boolean;
  /** To-one relation: FK to public.content_entries(id), plus an index on the column. */
  foreignKey?: { onDelete: ForeignKeyAction };
  /**
   * pg_trgm GIN index on the column, for search (prose text fields: see SEARCH_FIELD_TYPES). Present
   * only when true, so shapes recorded before this flag existed keep their hashes.
   */
  searchIndexed?: true;
}

/**
 * A model's table: content.<table>, storage columns (_entry_id, _variant, _locale; primary key; see STORAGE_COLUMNS in names.ts) plus one
 * column per field that has one. To-many relations have no column (they stay in content_relations).
 */
export interface TableShape {
  table: string;
  /** Keyed by column name; each column's `field` is its field key. */
  columns: Record<string, ColumnShape>;
}

export type PlanStage = "expand" | "destructive";

interface StepBase {
  stage: PlanStage;
  /** The UI's plain-words line for this step, e.g. "Adds a field: Title (text)". */
  summary: string;
}

export type PlanStep = StepBase & (
  | { kind: "create_table"; table: string; columns: ColumnShape[] }
  | { kind: "drop_table"; table: string; /** Filled by countDestructiveImpact. */ affectedRows?: number }
  /** Adds the column only (nullable, no constraints); constraints follow as their own steps. */
  | { kind: "add_column"; table: string; column: ColumnShape }
  | { kind: "drop_column"; table: string; column: string; /** The field key that left the schema. */ field: string; affectedValues?: number }
  /**
   * Renames the column and its index/constraint names (they derive from the column name). `column` is
   * the shape before the rename. The runner may implement it as expand and contract.
   */
  | { kind: "rename_column"; table: string; /** Column names. */ from: string; to: string; /** The new field key. */ field: string; column: ColumnShape }
  /** Fills empty values with the field's default (parameterised UPDATE), so a new required field can be validated. */
  | { kind: "backfill_column"; table: string; column: string; pgType: PgColumnType; value: unknown }
  /**
   * A field without a column (a to-many relation) left the schema: no DDL, but its permission rows go
   * and its name is reserved, exactly as for a dropped column.
   */
  | { kind: "drop_field_metadata"; table: string; field: string }
  /** Same column, new type, every value kept (e.g. bigint to numeric, anything to text). */
  | { kind: "change_type"; table: string; column: string; from: PgColumnType; to: PgColumnType; fromField: FieldType; toField: FieldType }
  /** Field type changed but the column type did not (e.g. text to email): no DDL, shape only. */
  | { kind: "change_field_type"; table: string; column: string; fromField: FieldType; toField: FieldType }
  /**
   * New type that existing values cannot all convert to: the column is dropped and re-added empty.
   * Always destructive. Constraints for the new column follow as their own (destructive) steps.
   */
  | { kind: "replace_column"; table: string; column: ColumnShape; fromField: FieldType; fromPgType: PgColumnType; affectedValues?: number }
  /** NOT VALID check, then VALIDATE. Fails if published rows have no value: see blockingRows. */
  | { kind: "set_required"; table: string; column: string; blockingRows?: number }
  | { kind: "drop_required"; table: string; column: string }
  /** Built CONCURRENTLY by the runner. A unique index fails on duplicates: see blockingRows. */
  | { kind: "add_index"; table: string; column: string; unique: boolean; blockingRows?: number }
  | { kind: "drop_index"; table: string; column: string; unique: boolean }
  /** pg_trgm GIN index (gin_trgm_ops) for search, built CONCURRENTLY by the runner. */
  | { kind: "add_search_index"; table: string; column: string }
  | { kind: "drop_search_index"; table: string; column: string }
  /** NOT VALID, then VALIDATE. */
  | { kind: "add_foreign_key"; table: string; column: string; onDelete: ForeignKeyAction }
  | { kind: "drop_foreign_key"; table: string; column: string }
);

export type PlanStepKind = PlanStep["kind"];

export interface MigrationPlan {
  /** Bumped when the plan format changes; the runner refuses versions it does not know. */
  formatVersion: 1;
  workspaceId: string;
  modelId: string;
  modelApiKey: string;
  table: string;
  /** Hash of the table's shape the plan was built from (null hash = the table does not exist yet). */
  baseShapeHash: SchemaHash;
  /** Shape after the expand stage; the destructive stage is refused unless the table is at this hash. */
  expandedShapeHash: SchemaHash;
  /** Shape after every stage. */
  targetShapeHash: SchemaHash;
  /** Canonical hash of the target model schema (null when the plan deletes the model). */
  targetSchemaHash: SchemaHash | null;
  /**
   * The content_model_versions row the plan builds toward (null for a preview of an unsaved schema, or
   * when the plan deletes the model). The worker rebuilds the plan from this version and the table's
   * recorded state (buildPlanFromTrustedState) and never executes a plan it was handed.
   */
  targetVersionId: string | null;
  /** Hash over everything above and the steps: the ledger's identity for this plan. */
  planHash: SchemaHash;
  baseShape: TableShape | null;
  expandedShape: TableShape | null;
  targetShape: TableShape | null;
  steps: PlanStep[];
  /** True when any step is destructive: the user must type the model's api key to run that stage. */
  requiresConfirmation: boolean;
  /** Notes for the UI that are not steps (e.g. "to-many relations are stored separately"). */
  notes: string[];
  /**
   * Field keys added back while their deletion was waiting for confirmation: their columns (and values)
   * stay, and this plan supersedes the waiting deletion. Informational; not part of the plan hash.
   */
  restoredFields?: string[];
}

/** Why a plan could not be built: a name rule, a cap, or a reserved name. Plain words, safe to show. */
export interface PlanProblem {
  code: "invalid_name" | "reserved_name" | "pending_deletion" | "cap_exceeded" | "invalid_rename" | "invalid_schema";
  message: string;
}

export type PlanResult = { ok: true; plan: MigrationPlan } | { ok: false; problems: PlanProblem[] };

/** One SQL statement of a rendered step, with how the runner must run it. */
export interface RenderedStatement {
  /** Parameterised SQL (identifiers quoted by Kysely's sql.id, types from PG_COLUMN_TYPES only). */
  sql: RawBuilder<unknown>;
  /** False for CREATE/DROP INDEX CONCURRENTLY, which cannot run inside a transaction. */
  transactional: boolean;
  /** Takes a lock that can queue other queries: run it under lock_timeout with retries. */
  lockSensitive: boolean;
  /**
   * Run in its own short transaction and commit straight after, so the lock it takes (SHARE ROW
   * EXCLUSIVE on content_entries for a foreign key) or the time it runs (VALIDATE, backfill) is not
   * held together with the rest of the stage.
   */
  ownTransaction: boolean;
}
