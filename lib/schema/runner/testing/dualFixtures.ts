// TEST ONLY. Fixtures for the runner's database tests (npm run test:dual): an owner session that
// runs stages (as the worker does), an app-role session that requests them (as the CMS does), and an
// owner client for fixtures and assertions.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { tableNameCandidates } from "@/lib/schema/engine/names";
import type { ColumnShape, MigrationPlan, PlanStage, TableShape } from "@/lib/schema/engine/plan";
import { kyselyOn } from "@/lib/schema/runner/engine";
import { requestPlanStage } from "@/lib/schema/runner/request";
import { runNextStage, type RunnerOptions, type StageOutcome } from "@/lib/schema/runner/runner";
import { bare, buildPlan, constraintSteps, shape, testEngine } from "@/lib/schema/runner/testing/plans";

function url(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run node scripts/dev-db/setup.mjs, then npm run test:dual.`);
  return value;
}

export async function connect(kind: "owner" | "app"): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url(kind === "owner" ? "POLYNOVEA_TEST_POSTGRES_OWNER_URL" : "POLYNOVEA_TEST_POSTGRES_URL"), ssl: false });
  await client.connect();
  return client;
}

export interface Model {
  workspaceId: string;
  adminId: string;
  modelId: string;
  apiKey: string;
  table: string;
  shape: TableShape | null;
}

export const FAST_RETRY = { backoffMs: [50, 100, 150, 200, 250] } as const;

export class RunnerHarness {
  owner!: pg.Client;
  app!: pg.Client;
  session!: pg.Client;

  async open() {
    [this.owner, this.app, this.session] = await Promise.all([connect("owner"), connect("app"), connect("owner")]);
  }

  async close() {
    await Promise.all([this.owner, this.app, this.session].map((client) => client?.end().catch(() => undefined)));
  }

  async newModel(): Promise<Model> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const { rows: [ws] } = await this.owner.query("insert into workspaces (name, slug) values ($1, $2) returning id", [`Runner ${suffix}`, `runner-${suffix}`]);
    const { rows: [admin] } = await this.owner.query("insert into admin_users (username, email) values ($1, $2) returning id", [`runner-${suffix}`, `runner-${suffix}@example.test`]);
    const apiKey = `posts_${suffix}`;
    const { rows: [model] } = await this.owner.query("insert into content_models (workspace_id, name, api_key) values ($1, $2, $3) returning id", [ws.id, `Posts ${suffix}`, apiKey]);
    return { workspaceId: ws.id, adminId: admin.id, modelId: model.id, apiKey, table: tableNameCandidates(ws.id, apiKey)[0], shape: null };
  }

  /** `count` entries of the model; returns their ids. */
  async entries(model: Model, count: number): Promise<string[]> {
    const { rows } = await this.owner.query(
      "insert into content_entries (workspace_id, content_model_id) select $1, $2 from generate_series(1, $3) returning id",
      [model.workspaceId, model.modelId, count],
    );
    return rows.map((row) => row.id as string);
  }

  plan(model: Model, next: TableShape | null, steps: Parameters<typeof buildPlan>[0]["steps"], target?: TableShape | null): MigrationPlan {
    return buildPlan({ workspaceId: model.workspaceId, modelId: model.modelId, modelApiKey: model.apiKey, table: model.table, base: model.shape, expanded: next, target, steps });
  }

  /** Requests a stage as the app role, the way the CMS does. */
  async request(model: Model, plan: MigrationPlan, stage: PlanStage = "expand"): Promise<string> {
    const { ledgerId } = await requestPlanStage(kyselyOn(this.app), { plan, stage, requestedBy: model.adminId });
    return ledgerId;
  }

  async run(model: Model, options: Partial<RunnerOptions> = {}): Promise<StageOutcome | null> {
    return runNextStage(this.session, {
      engine: testEngine, workerId: "test-worker", releaseId: "test-release", retry: FAST_RETRY, ...options, modelId: model.modelId,
    });
  }

  /** Creates the model's table with `columns` (and their constraints, as the planner would) through the runner. */
  async createTable(model: Model, columns: ColumnShape[]): Promise<void> {
    const next = shape(model.table, columns);
    const plan = this.plan(model, next, [{ kind: "create_table", stage: "expand", columns: columns.map(bare) }, ...columns.flatMap(constraintSteps)]);
    await this.request(model, plan);
    const outcome = await this.run(model);
    if (outcome?.outcome !== "succeeded") throw new Error(`create table failed: ${JSON.stringify(outcome)}`);
    model.shape = next;
  }

  async ledger(id: string) {
    const { rows: [row] } = await this.owner.query("select * from schema_migration_ledger where id = $1", [id]);
    return row;
  }

  async runRow(ledgerId: string) {
    const { rows: [row] } = await this.owner.query("select * from schema_migration_runs where ledger_id = $1", [ledgerId]);
    return row;
  }

  async columns(model: Model): Promise<Record<string, string>> {
    const { rows } = await this.owner.query(
      "select column_name, data_type from information_schema.columns where table_schema = 'content' and table_name = $1",
      [model.table],
    );
    return Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]));
  }

  async indexes(model: Model): Promise<Array<{ name: string; valid: boolean }>> {
    const { rows } = await this.owner.query(
      `select ic.relname as name, i.indisvalid as valid from pg_index i
         join pg_class ic on ic.oid = i.indexrelid join pg_class tc on tc.oid = i.indrelid
         join pg_namespace n on n.oid = tc.relnamespace
        where n.nspname = 'content' and tc.relname = $1 order by 1`,
      [model.table],
    );
    return rows;
  }

  /** Puts a failed stage back in the queue, as a "Retry" in the UI would (app role). */
  async retry(ledgerId: string) {
    await this.app.query("update schema_migration_ledger set status = 'pending' where id = $1", [ledgerId]);
  }
}
