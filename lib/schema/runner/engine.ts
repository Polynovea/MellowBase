// What the runner needs from the schema engine (phase 3 wave 1), as one injected object.
//
// The runner never writes its own SQL for a plan step: it re-renders every step through the engine's
// renderStep and only decides HOW each statement runs (lock timeout and retries, outside a transaction
// for CONCURRENTLY, expand and contract for renames and type changes). The plan hash, the "is this
// stage still current" gate and the bookkeeping after a stage (the model's applied shape, field
// permission rows, name reservations) are the engine's too.
import { DummyDriver, Kysely, PostgresAdapter, PostgresDialect, PostgresIntrospector, PostgresQueryCompiler, type RawBuilder } from "kysely";
import type pg from "pg";
import type { DbExecutor, DbTransaction } from "@/lib/db";
import type { DB } from "@/lib/db/generated/database";
import type { SchemaLimits } from "@/lib/schema/engine/limits";
import type { MigrationPlan, PlanStage, PlanStep, RenderedStatement, SchemaHash } from "@/lib/schema/engine/plan";

export interface SchemaEngine {
  /** The SQL for one step, in order, each with how it must run. */
  renderStep(step: PlanStep): RenderedStatement[];
  /** The plan's identity hash, recomputed from its contents. */
  computePlanHash(plan: MigrationPlan): SchemaHash;
  /** Throws unless the plan is well formed, within the name rules and caps, and its hashes replay. Pure. */
  validatePlan(plan: MigrationPlan, options?: { limits?: SchemaLimits }): void;
  /**
   * Validates the plan, locks the model's rows (FOR UPDATE) and throws unless the model's applied
   * shape hash equals the stage's starting hash (baseShapeHash for expand, expandedShapeHash for
   * destructive). Only ever called in a short transaction of its own (the gate) or in the final one.
   */
  assertStageCurrent(trx: DbTransaction, plan: MigrationPlan, stage: PlanStage, options?: { limits?: SchemaLimits }): Promise<unknown>;
  /**
   * After every step of the stage ran: records the stage's resulting shape and hash, moves or deletes
   * permission rows and reserves names. Runs in the runner's final transaction, with "succeeded".
   */
  applyStageBookkeeping(trx: DbTransaction, plan: MigrationPlan, stage: PlanStage): Promise<void>;
}

/** A Kysely that only compiles (never connects): turns a RawBuilder into SQL text and parameters. */
const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export interface CompiledStatement {
  text: string;
  values: unknown[];
}

export function compile(statement: RawBuilder<unknown>): CompiledStatement {
  const compiled = statement.compile(compiler);
  return { text: compiled.sql, values: [...compiled.parameters] };
}

/** A Kysely bound to one checked-out client, so engine functions run on the runner's session. */
export function kyselyOn(client: pg.ClientBase): DbExecutor {
  const borrowed = { query: (...args: unknown[]) => (client.query as (...a: unknown[]) => unknown)(...args), release: () => {} };
  const single = { connect: async () => borrowed, end: async () => {} };
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: single as unknown as pg.Pool }) });
}

/**
 * The same, typed as a transaction: for engine functions that must run inside a transaction the
 * runner has already opened on `client` (BEGIN ... COMMIT around the call).
 */
export function transactionOn(client: pg.ClientBase): DbTransaction {
  return kyselyOn(client) as unknown as DbTransaction;
}
