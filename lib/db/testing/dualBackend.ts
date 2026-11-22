/**
 * Runs one test file against both data backends (phase 1 ground rule 3: "same tests on both paths").
 *
 *   describeBothBackends("taxonomy", "taxonomy service", (backend) => {
 *     it("lists", async () => { const ws = await backend.createWorkspace(); ... });
 *   });
 *
 * registers the suite twice: once with the area on "supabase" (supabase-js through PostgREST over
 * Supabase's PostgreSQL image) and once on "postgres" (lib/db straight to plain PostgreSQL 16 as the
 * polynovea_app role). The databases come from `node scripts/dev-db/setup.mjs`; dual tests run with
 * `npm run test:dual`, which refuses to start without them rather than skipping.
 *
 * Fixture rows are written with an owner connection to whichever database the backend uses, so each
 * test sees its own fresh workspace and tests never depend on each other's data.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe } from "vitest";
import { DATA_BACKENDS, type DataArea, type DataBackend } from "@/lib/db/backend";
import { closeDb } from "@/lib/db/index";

export interface BackendFixtures {
  readonly name: DataBackend;
  /** Runs SQL as the database owner on this backend's database (fixtures and assertions only). */
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

function ownerUrlFor(backend: DataBackend): string {
  return backend === "postgres" ? requireEnv("POLYNOVEA_TEST_POSTGRES_OWNER_URL") : requireEnv("POLYNOVEA_TEST_SUPABASE_DB_URL");
}

function fixturesFor(backend: DataBackend, client: () => pg.Client): BackendFixtures {
  const query = async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => (await client().query<R>(text, values)).rows;
  return {
    name: backend,
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

/**
 * Registers `suite` once per backend for `area` (or several areas switched together). Inside, `backend.name` says which one is running.
 */
export function describeBothBackends(area: DataArea | DataArea[], title: string, suite: (backend: BackendFixtures) => void): void {
  // Several areas switch together when one area's code reads another's data (for example schema
  // delivery runs that point at schema models): they must come from the same database.
  const areas = Array.isArray(area) ? area : [area];
  for (const backendName of DATA_BACKENDS) {
    describe(`${title} [${backendName}]`, () => {
      let client: pg.Client | null = null;
      let previous: string | undefined;

      beforeAll(async () => {
        previous = process.env.POLYNOVEA_DATA_BACKEND;
        process.env.POLYNOVEA_DATA_BACKEND = ["supabase", ...areas.map((name) => `${name}=${backendName}`)].join(",");
        client = new pg.Client({ connectionString: ownerUrlFor(backendName), ssl: false });
        await client.connect();
      });

      afterAll(async () => {
        if (previous === undefined) delete process.env.POLYNOVEA_DATA_BACKEND;
        else process.env.POLYNOVEA_DATA_BACKEND = previous;
        await client?.end();
        await closeDb();
      });

      suite(fixturesFor(backendName, () => {
        if (!client) throw new Error("Backend fixtures used outside a test");
        return client;
      }));
    });
  }
}
