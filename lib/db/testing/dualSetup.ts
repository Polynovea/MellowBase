/**
 * Vitest setup for `npm run test:dual`: loads .env.test.local (written by scripts/dev-db/setup.mjs)
 * and points the app at the local test database before any test module is imported.
 * Fails loudly when the database is not configured; these tests never skip silently.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), ".env.test.local");
if (!existsSync(file)) {
  throw new Error("Missing .env.test.local. Start the local test databases with: node scripts/dev-db/setup.mjs");
}
for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

const required = ["POLYNOVEA_TEST_POSTGRES_URL", "POLYNOVEA_TEST_POSTGRES_OWNER_URL"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`.env.test.local is missing ${missing.join(", ")}. Re-run node scripts/dev-db/setup.mjs`);

// The CMS's database: plain PostgreSQL as the polynovea_app role (no DDL rights).
process.env.POLYNOVEA_DATABASE_URL = process.env.POLYNOVEA_TEST_POSTGRES_URL;
delete process.env.DATABASE_URL;
// Supabase compatibility services (setup.mjs --with-supabase), used by the GoTrue migration tests and
// the Supabase auth rollback; absent otherwise.
if (process.env.POLYNOVEA_TEST_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.POLYNOVEA_TEST_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.POLYNOVEA_TEST_SUPABASE_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.POLYNOVEA_TEST_SUPABASE_SERVICE_ROLE_KEY;
}
