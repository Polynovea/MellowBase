/**
 * Database fixtures for the integration tests (`npm run test:dual`), which run against plain
 * PostgreSQL as the polynovea_app role:
 *
 *   describeWithDatabase("taxonomy service", (db) => {
 *     it("lists", async () => { const ws = await db.createWorkspace(); ... });
 *   });
 *
 * The database comes from `node scripts/dev-db/setup.mjs`; the tests refuse to start without it
 * rather than skipping. Fixture rows are written with an owner connection, so each test sees its own
 * fresh workspace and tests never depend on each other's data.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe } from "vitest";
import { closeDb } from "@/lib/db/index";

export interface BackendFixtures {
  /** Runs SQL as the database owner (fixtures and assertions only). */
  query<R extends pg.QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]): Promise<R[]>;
  /** A new workspace and an admin user in it. */
  createWorkspace(): Promise<{ workspaceId: string; adminUserId: string }>;
  /** A content model, an entry and `versions` versions of it in the workspace. */
  createEntry(workspaceId: string, versions?: number): Promise<{ entryId: string; versionIds: string[] }>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run node scripts/dev-db/setup.mjs, then npm run test:dual.`);
  return value;
}

function fixtures(client: () => pg.Client): BackendFixtures {
  const query = async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => (await client().query<R>(text, values)).rows;
  return {
    query,
    async createWorkspace() {
      const suffix = randomUUID().slice(0, 8);
      const [workspace] = await query<{ id: string }>(
        "insert into workspaces (name, slug) values ($1, $2) returning id",
        [`Dual test ${suffix}`, `dual-${suffix}`],
      );
      const [admin] = await query<{ id: string }>(
        "insert into admin_users (username, email) values ($1, $2) returning id",
        [`dual-${suffix}`, `dual-${suffix}@example.test`],
      );
      return { workspaceId: workspace.id, adminUserId: admin.id };
    },
    async createEntry(workspaceId, versions = 1) {
      const suffix = randomUUID().slice(0, 8);
      const [model] = await query<{ id: string }>(
        "insert into content_models (workspace_id, name, api_key) values ($1, $2, $3) returning id",
        [workspaceId, `Model ${suffix}`, `model_${suffix.replace(/-/g, "")}`],
      );
      const [entry] = await query<{ id: string }>(
        "insert into content_entries (workspace_id, content_model_id) values ($1, $2) returning id",
        [workspaceId, model.id],
      );
      const versionIds: string[] = [];
      for (let n = 1; n <= versions; n += 1) {
        const [version] = await query<{ id: string }>(
          "insert into content_entry_versions (entry_id, model_schema_version, version_number) values ($1, 1, $2) returning id",
          [entry.id, n],
        );
        versionIds.push(version.id);
      }
      return { entryId: entry.id, versionIds };
    },
  };
}

/** Registers `suite` with fixtures over an owner connection to the test database. */
export function describeWithDatabase(title: string, suite: (db: BackendFixtures) => void): void {
  describe(title, () => {
    let client: pg.Client | null = null;

    beforeAll(async () => {
      client = new pg.Client({ connectionString: requireEnv("POLYNOVEA_TEST_POSTGRES_OWNER_URL"), ssl: false });
      await client.connect();
    });

    afterAll(async () => {
      await client?.end();
      await closeDb();
    });

    suite(fixtures(() => {
      if (!client) throw new Error("Database fixtures used outside a test");
      return client;
    }));
  });
}
