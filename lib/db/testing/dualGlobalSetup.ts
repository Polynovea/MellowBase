/**
 * Vitest global setup for `npm run test:dual`, run once before any test file.
 *
 * Refuses to start unless both test databases are on the newest migration and PostgREST serves it.
 * Without this, a run started while the stack was still migrating, or while PostgREST was reloading
 * its schema, failed in confusing ways (a half-migrated database, an empty read on the Supabase
 * side). The message says what to do instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

function readEnv(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

async function latestApplied(url: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const { rows } = await client.query<{ filename: string }>("select filename from polynovea_migration_ledger order by filename desc limit 1");
    return rows[0]?.filename ?? null;
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  const root = process.cwd();
  const file = path.join(root, ".env.test.local");
  if (!existsSync(file)) throw new Error("Missing .env.test.local. Start the local test databases with: node scripts/dev-db/setup.mjs");
  const env = readEnv(file);
  if (!env.POLYNOVEA_DEV_STACK) {
    throw new Error(".env.test.local predates per-checkout database stacks. Run: node scripts/dev-db/setup.mjs --reset");
  }
  const newest = readdirSync(path.join(root, "supabase", "migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().at(-1);
  const hint = "Run node scripts/dev-db/setup.mjs (wait for it to finish) before npm run test:dual.";

  for (const [label, url] of [["plain PostgreSQL", env.POLYNOVEA_TEST_POSTGRES_OWNER_URL], ["Supabase PostgreSQL", env.POLYNOVEA_TEST_SUPABASE_DB_URL]] as const) {
    let applied: string | null;
    try {
      applied = await latestApplied(url);
    } catch (error) {
      throw new Error(`Cannot read the migration ledger of the ${label} test database (${error instanceof Error ? error.message : String(error)}). ${hint}`);
    }
    if (applied !== newest) throw new Error(`The ${label} test database is at ${applied ?? "no migration"}, not ${newest}. ${hint}`);
  }

  const key = env.POLYNOVEA_TEST_SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${env.POLYNOVEA_TEST_SUPABASE_URL}/rest/v1/polynovea_migration_ledger?select=filename&order=filename.desc&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).catch((error: unknown) => {
    throw new Error(`PostgREST is not reachable (${error instanceof Error ? error.message : String(error)}). ${hint}`);
  });
  const body = response.ok ? (await response.json()) as { filename?: string }[] : null;
  if (body?.[0]?.filename !== newest) {
    throw new Error(`PostgREST does not serve ${newest} yet (HTTP ${response.status}, latest ${body?.[0]?.filename ?? "unknown"}). ${hint}`);
  }
}
