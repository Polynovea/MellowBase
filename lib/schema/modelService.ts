// Schema area: types, the shared validate → diff → apply rules.
//
// The database primitives come from PostgreSQL in modelService.postgres.ts. Everything that decides
// what is allowed (canonical schema validation, apiKey immutability, diff classification, the
// acknowledge-unsafe gate) stays here.
import { logPlatformEvent } from "@/lib/platform/audit";
import { hashModelSchema } from "@/lib/schema/engine/hash";
import * as postgres from "@/lib/schema/modelService.postgres";
import { withTransaction, type DbExecutor } from "@/lib/db/index";
import { requestSchemaChange } from "@/lib/schema/runner/request";
import { schemaLimitsFromEnv } from "@/lib/schema/engine/limits";
import { SchemaEngineError } from "@/lib/schema/engine/errors";
import { validateCanonicalSchema } from "@/lib/schema/canonicalSchema";
import { computeSchemaDiff, type SchemaDiff } from "@/lib/schema/diff";
import { resolveModelCapability, type CanonicalSchema, type ModelCapability } from "@/lib/schema/fields/types";

export interface ContentModelRow {
  id: string;
  workspace_id: string;
  name: string;
  api_key: string;
  description: string | null;
  icon: string | null;
  status: "draft" | "active" | "archived";
  current_schema_version: number;
  /**
   * A read-optimized projection of the current version's `capability` and
   * `permissions`, kept in sync by `createModel`/`applyChange` — never an
   * independently editable source. The canonical schema version's
   * `schema_json` remains authoritative (ADR-004, ADR-016).
   */
  settings_json: { capability?: ModelCapability };
  created_by: string | null;
  created_at: string;
  updated_at: string;
  current_schema?: CanonicalSchema | null;
}

export interface ContentModelVersionRow {
  id: string;
  content_model_id: string;
  version_number: number;
  schema_json: CanonicalSchema;
  schema_hash: string;
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * SHA-256 of the schema's canonical JSON (keys sorted at every depth), so any change to any field
 * changes it. Before migration 0075 this passed the top-level keys as JSON.stringify's replacer,
 * which filters keys at every depth: field contents were ignored and different schemas collided.
 * 0075 re-hashed stored versions (and the copies of their hashes) with this function's SQL twin.
 */
export function computeSchemaHash(schema: CanonicalSchema): string {
  return hashModelSchema(schema);
}

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export async function createModel(params: {
  workspaceId: string;
  description?: string;
  icon?: string;
  proposedSchema: unknown;
  createdBy: string;
}): Promise<ServiceResult<{ model: ContentModelRow; version: ContentModelVersionRow; schemaChange: QueuedSchemaChange }>> {
  const validation = validateCanonicalSchema(params.proposedSchema);
  if (!validation.valid || !validation.schema) {
    return { ok: false, error: validation.errors.join("; "), status: 400 };
  }
  const schema = validation.schema;

  // The model, its first version and the request for its table commit together (or not at all).
  return inTransactionWithSchemaChange(params.createdBy, async (trx) => {
    const created = await postgres.createModelRecord({
      workspaceId: params.workspaceId,
      actorId: params.createdBy,
      schema,
      description: params.description ?? null,
      icon: params.icon ?? null,
      hash: computeSchemaHash(schema),
      capability: resolveModelCapability(schema),
      db: trx,
    });
    return created.ok
      ? { ok: true as const, data: created.data, modelId: created.data.model.id, versionId: created.data.version.id }
      : { ok: false as const, error: created.error, status: created.status };
  });
}

/** What a model write queued for the schema worker (Phase 3 runner; Phase 4 wiring). */
export interface QueuedSchemaChange {
  /** Additive steps (new table, new columns, indexes): pending, applied automatically. */
  expandLedgerId: string | null;
  /** Deleting steps: awaiting_confirmation until someone types the model's api key. */
  destructiveLedgerId: string | null;
}

class RollbackWith extends Error {
  constructor(readonly outcome: { ok: false; error: string; status: number }) {
    super("rollback");
  }
}

/**
 * Runs a model write and queues its schema change (requestSchemaChange) in ONE transaction: a version
 * never exists without its ledger rows, nor ledger rows without their version. A refusal from the
 * schema engine (a cap, a reserved name, an invalid plan) rolls the version back and is returned as
 * the write's error.
 */
type Written<D> = { ok: true; data: D; modelId: string; versionId: string } | { ok: false; error: string; status?: number };

async function inTransactionWithSchemaChange<D extends object>(
  actorId: string,
  write: (trx: DbExecutor) => Promise<Written<D>>,
): Promise<{ ok: true; data: D & { schemaChange: QueuedSchemaChange } } | { ok: false; error: string; status: number }> {
  try {
    return await withTransaction(async (trx) => {
      const written = await write(trx);
      if (!written.ok) throw new RollbackWith({ ok: false, error: written.error ?? "Could not save the model", status: written.status ?? 500 });
      const { expandLedgerId, destructiveLedgerId } = await requestSchemaChange(trx, {
        contentModelId: written.modelId, targetVersionId: written.versionId, requestedBy: actorId, limits: schemaLimitsFromEnv(),
      });
      return { ok: true as const, data: { ...written.data, schemaChange: { expandLedgerId, destructiveLedgerId } } };
    });
  } catch (error) {
    if (error instanceof RollbackWith) return error.outcome;
    if (error instanceof SchemaEngineError) return { ok: false, error: error.message, status: error.status };
    throw error;
  }
}

/** The content_fields rows a canonical schema projects to. */
export function contentFieldRows(contentModelId: string, schema: CanonicalSchema) {
  return schema.fields.map((field, index) => ({
    content_model_id: contentModelId,
    field_key: field.key,
    label: field.label,
    field_type: field.type,
    position: index,
    configuration_json: {
      required: field.required,
      localized: field.localized,
      unique: field.unique,
      defaultValue: field.defaultValue ?? null,
      validation: field.validation ?? {},
      relation: field.relation ?? null,
      generatedFrom: field.generatedFrom ?? null,
      index: field.index ?? false,
      providerSpecific: field.providerSpecific ?? false,
      uiHints: field.uiHints ?? {},
    },
  }));
}


export const rebuildContentFields = postgres.rebuildContentFields;
export const getModel = postgres.getModel;
export const listModels = postgres.listModels;
export const listVersions = postgres.listVersions;
export const getVersion = postgres.getVersion;
export const updateModelMetadata = postgres.updateModelMetadata;

export async function diffVersions(
  modelId: string,
  fromVersion: number,
  toVersion: number,
): Promise<ServiceResult<SchemaDiff>> {
  const [from, to] = await Promise.all([getVersion(modelId, fromVersion), getVersion(modelId, toVersion)]);
  if (!from) return { ok: false, error: `Version ${fromVersion} not found`, status: 404 };
  if (!to) return { ok: false, error: `Version ${toVersion} not found`, status: 404 };
  return { ok: true, data: computeSchemaDiff(from.schema_json, to.schema_json) };
}

export interface ProposeChangeResult {
  diff: SchemaDiff;
  proposedSchema: CanonicalSchema;
  currentVersion: ContentModelVersionRow;
}

async function proposeChange(model: ContentModelRow, proposedSchema: unknown): Promise<ServiceResult<ProposeChangeResult>> {
  const validation = validateCanonicalSchema(proposedSchema);
  if (!validation.valid || !validation.schema) {
    return { ok: false, error: validation.errors.join("; "), status: 400 };
  }
  if (validation.schema.apiKey !== model.api_key) {
    return { ok: false, error: "apiKey cannot be changed after a model is created", status: 400 };
  }

  const currentVersion = await getVersion(model.id, model.current_schema_version);
  if (!currentVersion) {
    return { ok: false, error: "Current schema version not found — data integrity issue", status: 500 };
  }

  const diff = computeSchemaDiff(currentVersion.schema_json, validation.schema);
  return { ok: true, data: { diff, proposedSchema: validation.schema, currentVersion } };
}

export async function validateChange(model: ContentModelRow, proposedSchema: unknown): Promise<ServiceResult<ProposeChangeResult>> {
  return proposeChange(model, proposedSchema);
}

export interface ApplyChangeResult {
  applied: boolean;
  diff: SchemaDiff;
  version?: ContentModelVersionRow;
  blockedReason?: string;
  /** A reviewed schema identical to the current version is never versioned again. */
  noChanges?: boolean;
  /** The schema change queued with the new version (applied by the schema worker). */
  schemaChange?: QueuedSchemaChange;
}

export async function applyChange(params: {
  model: ContentModelRow;
  proposedSchema: unknown;
  changeSummary?: string;
  acknowledgeUnsafe: boolean;
  actorAdminUserId: string;
}): Promise<ServiceResult<ApplyChangeResult>> {
  const proposed = await proposeChange(params.model, params.proposedSchema);
  if (!proposed.ok) return proposed;

  const { diff, proposedSchema, currentVersion } = proposed.data;

  if (diff.entries.length === 0) {
    return {
      ok: true,
      data: {
        applied: false,
        noChanges: true,
        diff,
        blockedReason: "No schema changes to apply",
      },
    };
  }

  if (diff.overallClassification !== "SAFE" && !params.acknowledgeUnsafe) {
    return {
      ok: true,
      data: {
        applied: false,
        diff,
        blockedReason: `Change classified as ${diff.overallClassification} — pass acknowledgeUnsafe: true to apply anyway`,
      },
    };
  }

  await logPlatformEvent({
    workspaceId: params.model.workspace_id,
    actorAdminUserId: params.actorAdminUserId,
    action: "schema.migration.started",
    entityType: "content_model",
    entityId: params.model.id,
    metadata: { fromVersion: currentVersion.version_number, toVersion: currentVersion.version_number + 1 },
  });

  // The new version and the request to reshape the model's table commit together (or not at all).
  const queued = await inTransactionWithSchemaChange(params.actorAdminUserId, async (trx) => {
    const result = await postgres.applySchemaVersion({
      model: params.model,
      actorId: params.actorAdminUserId,
      schema: proposedSchema,
      hash: computeSchemaHash(proposedSchema),
      changeSummary: params.changeSummary ?? null,
      capability: resolveModelCapability(proposedSchema),
      db: trx,
    });
    return result.ok
      ? { ok: true as const, data: { version: result.version }, modelId: params.model.id, versionId: result.version.id }
      : { ok: false as const, error: result.error, status: 500 };
  });
  const applied = queued.ok
    ? { ok: true as const, version: queued.data.version, schemaChange: queued.data.schemaChange }
    : { ok: false as const, error: queued.error, status: queued.status };

  if (!applied.ok) {
    await logPlatformEvent({
      workspaceId: params.model.workspace_id,
      actorAdminUserId: params.actorAdminUserId,
      action: "schema.migration.failed",
      entityType: "content_model",
      entityId: params.model.id,
      metadata: { error: applied.error },
    });
    return { ok: false, error: applied.error, status: applied.status ?? 500 };
  }

  return { ok: true, data: { applied: true, diff, version: applied.version, schemaChange: applied.schemaChange } };
}
