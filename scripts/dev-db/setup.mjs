// Starts the local test database (plain PostgreSQL) and Azurite, applies every migration, gives the
// database its least-privilege app role, and writes .env.test.local.
//
// Usage: node scripts/dev-db/setup.mjs [--pg=15|16|17] [--with-supabase] [--reset | --down]
//   --pg=N           PostgreSQL major version for the test database (default 16). Switching versions
//                    drops this checkout's volumes first, since a data directory belongs to one version.
//   --with-supabase  also starts the Supabase compatibility services (Supabase's PostgreSQL, PostgREST,
//                    GoTrue) and migrates them, for the tests that need them: Supabase installs still
//                    upgrade with these migrations, and the built-in auth imports GoTrue users. Without
//                    it, `npm run test:dual` leaves those tests out and says so.
//   --reset          drops this checkout's database volumes first (all local test data is lost)
//   --down           stops this checkout's stack (every service) and drops its volumes, then exits
//
// Each checkout (git worktree) runs its own stack: Compose project `polynovea-dev-<id>` and ports
// derived from the checkout's path (override with POLYNOVEA_DEV_PORT_BASE before the first run), both
// recorded in .env.test.local. Sessions in different worktrees used to share one stack, so a reset or
// a PostgREST restart in one swapped the databases under the other's running tests. The tests refuse
// to start until the databases are on the newest migration (lib/db/testing/dualGlobalSetup.ts).
//
// Local test only. The generated passwords and JWT secret live in .env.test.local (gitignored)
// and protect containers bound to 127.0.0.1. Never point this script at a real database.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { bootstrapInstallRoles } from "../../lib/db/roles.mjs";
import { retryOnRestart, waitForStableDatabase } from "./waitForDatabase.mjs";

const root = process.cwd();
const envFile = path.join(root, ".env.test.local");
const composeFile = path.join(root, "scripts", "dev-db", "compose.yml");
const reset = process.argv.includes("--reset");
const down = process.argv.includes("--down");
const withSupabase = process.argv.includes("--with-supabase");
const SUPPORTED_PG = ["15", "16", "17"];
const pgArg = process.argv.find((arg) => arg.startsWith("--pg="));
const pgVersion = pgArg ? pgArg.slice("--pg=".length) : "16";
if (!SUPPORTED_PG.includes(pgVersion)) throw new Error(`--pg must be one of ${SUPPORTED_PG.join(", ")} (got ${pgVersion})`);

function readEnvFile(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

const base64url = (value) => Buffer.from(value).toString("base64url");
function signJwt(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

const secret = () => randomBytes(24).toString("hex");
const existing = readEnvFile(envFile);
const env = {
  POLYNOVEA_DEV_ADMIN_PASSWORD: existing.POLYNOVEA_DEV_ADMIN_PASSWORD || secret(),
  POLYNOVEA_DEV_OWNER_PASSWORD: existing.POLYNOVEA_DEV_OWNER_PASSWORD || secret(),
  POLYNOVEA_DEV_APP_PASSWORD: existing.POLYNOVEA_DEV_APP_PASSWORD || secret(),
  POLYNOVEA_DEV_INSTALLER_PASSWORD: existing.POLYNOVEA_DEV_INSTALLER_PASSWORD || secret(),
  POLYNOVEA_DEV_SUPABASE_DB_PASSWORD: existing.POLYNOVEA_DEV_SUPABASE_DB_PASSWORD || secret(),
  POLYNOVEA_DEV_JWT_SECRET: existing.POLYNOVEA_DEV_JWT_SECRET || randomBytes(32).toString("hex"),
  // Azurite account key for this checkout (Azurite's well-known public key is never used).
  POLYNOVEA_DEV_AZURITE_KEY: existing.POLYNOVEA_DEV_AZURITE_KEY || randomBytes(64).toString("base64"),
};
// This checkout's stack: a stable ID and port block from its path, kept once chosen.
const checkoutHash = createHash("sha256").update(path.resolve(root).toLowerCase()).digest();
const stackId = existing.POLYNOVEA_DEV_STACK || checkoutHash.toString("hex").slice(0, 8);
const portBase = Number(existing.POLYNOVEA_DEV_PORT_BASE || process.env.POLYNOVEA_DEV_PORT_BASE || 26000 + (checkoutHash.readUInt16BE(0) % 300) * 10);
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65000) throw new Error("POLYNOVEA_DEV_PORT_BASE must be an integer between 1024 and 65000");
const stack = {
  POLYNOVEA_DEV_STACK: stackId,
  POLYNOVEA_DEV_PG_VERSION: pgVersion,
  POLYNOVEA_DEV_PORT_BASE: String(portBase),
  POLYNOVEA_DEV_PLAIN_PORT: String(portBase),
  POLYNOVEA_DEV_SUPABASE_PORT: String(portBase + 1),
  POLYNOVEA_DEV_GATEWAY_PORT: String(portBase + 2),
  POLYNOVEA_DEV_AZURITE_PORT: String(portBase + 3),
};
const project = `polynovea-dev-${stackId}`;
const plainHost = `127.0.0.1:${stack.POLYNOVEA_DEV_PLAIN_PORT}`;
const supabaseHost = `127.0.0.1:${stack.POLYNOVEA_DEV_SUPABASE_PORT}`;
const gatewayUrl = `http://127.0.0.1:${stack.POLYNOVEA_DEV_GATEWAY_PORT}`;

const now = Math.floor(Date.now() / 1000);
const serviceRoleKey = signJwt({ role: "service_role", iss: "supabase-dev", iat: now, exp: now + 10 * 365 * 24 * 3600 }, env.POLYNOVEA_DEV_JWT_SECRET);
const anonKey = signJwt({ role: "anon", iss: "supabase-dev", iat: now, exp: now + 10 * 365 * 24 * 3600 }, env.POLYNOVEA_DEV_JWT_SECRET);

const adminUrl = `postgresql://polynovea_admin:${env.POLYNOVEA_DEV_ADMIN_PASSWORD}@${plainHost}/polynovea`;
// Stand-in for the RDS master user / Azure administrator: CREATEROLE and CREATEDB, not a superuser.
const installerUrl = `postgresql://polynovea_installer:${env.POLYNOVEA_DEV_INSTALLER_PASSWORD}@${plainHost}/polynovea`;
const ownerUrl = `postgresql://polynovea_owner:${env.POLYNOVEA_DEV_OWNER_PASSWORD}@${plainHost}/polynovea`;
const appUrl = `postgresql://polynovea_app:${env.POLYNOVEA_DEV_APP_PASSWORD}@${plainHost}/polynovea`;
const supabaseDbUrl = `postgresql://postgres:${env.POLYNOVEA_DEV_SUPABASE_DB_PASSWORD}@${supabaseHost}/postgres`;
const supabaseAdminUrl = `postgresql://supabase_admin:${env.POLYNOVEA_DEV_SUPABASE_DB_PASSWORD}@${supabaseHost}/postgres`;

const output = {
  ...env,
  ...stack,
  // The test database: plain PostgreSQL, connected as the app role that cannot run DDL.
  POLYNOVEA_TEST_POSTGRES_URL: appUrl,
  POLYNOVEA_TEST_POSTGRES_OWNER_URL: ownerUrl,
  // Supabase compatibility services, only with --with-supabase.
  ...(withSupabase ? {
    POLYNOVEA_TEST_SUPABASE_URL: gatewayUrl,
    POLYNOVEA_TEST_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    POLYNOVEA_TEST_SUPABASE_ANON_KEY: anonKey,
    POLYNOVEA_TEST_SUPABASE_DB_URL: supabaseDbUrl,
  } : {}),
  // Azure Blob adapter tests (lib/media/azureBlobStorage.azurite.test.ts) against Azurite.
  POLYNOVEA_TEST_AZURITE_CONNECTION_STRING: `DefaultEndpointsProtocol=http;AccountName=polynoveadev;AccountKey=${env.POLYNOVEA_DEV_AZURITE_KEY};BlobEndpoint=http://127.0.0.1:${stack.POLYNOVEA_DEV_AZURITE_PORT}/polynoveadev;`,
};
writeFileSync(
  envFile,
  "# Generated by scripts/dev-db/setup.mjs for local tests only. Gitignored; do not commit or reuse.\n"
    + Object.entries(output).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
  { mode: 0o600 },
);

// Compose lets variables in the calling environment override --env-file, so a shell that sourced an
// older .env.test.local would start the wrong PostgreSQL version or ports. This run's values win.
const composeEnv = { ...process.env, ...env, ...stack };
const compose = (...args) => execFileSync("docker", ["compose", "-p", project, "-f", composeFile, "--env-file", envFile, ...args], { stdio: "inherit", env: composeEnv });
// Every profile, so --down and --reset also stop Supabase services started by an earlier run.
const composeAll = (...args) => compose("--profile", "supabase", ...args);
if (down) {
  composeAll("down", "-v");
  console.log(`Stopped ${project} and removed its volumes.`);
  process.exit(0);
}
const previousVersion = existing.POLYNOVEA_DEV_PG_VERSION || "16";
if (reset) {
  composeAll("down", "-v");
} else if (previousVersion !== pgVersion) {
  // A PostgreSQL data directory belongs to one major version, and Compose would reuse the old one.
  console.log(`Switching the test database from PostgreSQL ${previousVersion} to ${pgVersion}: dropping this checkout's volumes first.`);
  composeAll("down", "-v");
} else if (!withSupabase) {
  // Stop Supabase services an earlier --with-supabase run left behind.
  compose("--profile", "supabase", "stop", "supabase-db", "postgrest", "gotrue", "rest-gateway");
}
console.log(`Stack ${project}: PostgreSQL ${pgVersion} ${plainHost}, Azurite 127.0.0.1:${stack.POLYNOVEA_DEV_AZURITE_PORT}${withSupabase ? `, Supabase PostgreSQL ${supabaseHost}, gateway ${gatewayUrl}` : ""}`);
try {
  if (withSupabase) composeAll("up", "-d", "--wait");
  else compose("up", "-d", "--wait");
} catch (error) {
  throw new Error(`Could not start ${project}. If a port is taken, set POLYNOVEA_DEV_PORT_BASE to a free block of 4 ports and remove POLYNOVEA_DEV_PORT_BASE from .env.test.local.`, { cause: error });
}

function runMigrations(databaseUrl) {
  execFileSync(process.execPath, ["scripts/run-migrations.mjs", "--all"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl, Database_URL: "", database_url: "" },
  });
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  try {
    await client.connect();
  } catch (error) {
    if (url === adminUrl && error?.code === "28P01") {
      throw new Error("The local database was created before polynovea_admin existed. Run: node scripts/dev-db/setup.mjs --reset");
    }
    throw error;
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// A healthy container can still be the image's temporary init server, which then stops and hands over
// to the real one. Wait until the server answers several queries in a row, and repeat a setup step
// (each is safe to repeat) if its connection is cut by that restart anyway.
async function probe(url) {
  const client = new pg.Client({ connectionString: url, ssl: false });
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    await client.end().catch(() => {});
  }
}
const waitForPlain = () => waitForStableDatabase(() => probe(adminUrl));
const retryPlain = (step) => retryOnRestart(step, {
  waitAgain: waitForPlain,
  onRetry: (attempt) => console.log(`The test database restarted during setup; retrying (attempt ${attempt + 1} of 3).`),
});
await waitForPlain();

// Plain PostgreSQL. The image's superuser only creates polynovea_installer, a non-superuser with
// CREATEROLE and CREATEDB that owns the database: exactly what RDS and Azure hand an installer. The
// installer then runs the real install step, so these tests fail if it needs a superuser anywhere.
await retryPlain(() => withClient(adminUrl, async (client) => {
  const password = client.escapeLiteral(env.POLYNOVEA_DEV_INSTALLER_PASSWORD);
  await client.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'polynovea_installer') then
      create role polynovea_installer login nosuperuser createrole createdb;
    end if;
  end $$`);
  await client.query(`alter role polynovea_installer with login nosuperuser createrole createdb nobypassrls password ${password}`);
  await client.query("alter database polynovea owner to polynovea_installer");
  // Databases created before the installer existed have roles it did not create; give it the admin
  // option a creator would have had (a fresh --reset database never needs this).
  // PostgreSQL 15's CREATEROLE manages every non-superuser role, so only 16+ needs this.
  const { rows: [{ version }] } = await client.query("select current_setting('server_version_num')::int as version");
  for (const role of version >= 160000 ? ["polynovea_owner", "polynovea_app", "anon", "authenticated", "service_role", "postgres"] : []) {
    const { rows } = await client.query("select 1 from pg_roles where rolname = $1", [role]);
    if (rows.length) await client.query(`grant ${role} to polynovea_installer with admin true, inherit false, set false`);
  }
}));

// Plain PostgreSQL, as the installer: create polynovea_owner (not a superuser; owns schema public,
// runs migrations) and polynovea_app (rows and functions only), plus the Supabase role names the
// historical migrations grant to. Migration 0067 then gives polynovea_app its grants and a
// row-level security policy on every table, so tests hit the same rules as RDS or Azure.
await retryPlain(() => withClient(installerUrl, (client) => bootstrapInstallRoles(client, {
  database: "polynovea",
  ownerPassword: env.POLYNOVEA_DEV_OWNER_PASSWORD,
  appPassword: env.POLYNOVEA_DEV_APP_PASSWORD,
})));
runMigrations(ownerUrl);

// Supabase compatibility services (--with-supabase): PostgREST logs in as `authenticator` and GoTrue
// as `supabase_auth_admin` (only supabase_admin may set their passwords).
if (withSupabase) {
  const waitForSupabase = () => waitForStableDatabase(() => probe(supabaseAdminUrl));
  await waitForSupabase();
  await retryOnRestart(() => withClient(supabaseAdminUrl, async (client) => {
    const password = env.POLYNOVEA_DEV_SUPABASE_DB_PASSWORD.replace(/'/g, "''");
    await client.query(`alter role authenticator with login password '${password}'`);
    await client.query(`alter role supabase_auth_admin with login password '${password}'`);
  }), { waitAgain: waitForSupabase });
  runMigrations(supabaseDbUrl);
  await withClient(supabaseDbUrl, (client) => client.query("notify pgrst, 'reload schema'"));
  composeAll("restart", "postgrest", "gotrue", "rest-gateway");
  await waitForPostgrest();
}

// The version the server actually reports, so a run can never silently test another version.
const serverVersion = await withClient(adminUrl, async (client) => (await client.query("select version() as version")).rows[0].version);
if (!serverVersion.startsWith(`PostgreSQL ${pgVersion}.`)) throw new Error(`Asked for PostgreSQL ${pgVersion} but the server reports: ${serverVersion}`);
console.log(`\nLocal test stack ready: ${serverVersion}${withSupabase ? ", with the Supabase compatibility services" : ""}. Test settings written to .env.test.local.`);

// PostgREST reloads its schema cache asynchronously after a restart; a test that reads through it
// before that finishes can see errors or stale tables. Wait until it serves the newest migration.
async function waitForPostgrest() {
  const newest = readdirSync(path.join(root, "supabase", "migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().at(-1);
  const url = `${gatewayUrl}/rest/v1/polynovea_migration_ledger?select=filename&order=filename.desc&limit=1`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const deadline = Date.now() + 90_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      const body = response.ok ? await response.json() : null;
      if (body?.[0]?.filename === newest) return;
      last = response.ok ? `latest migration ${body?.[0]?.filename ?? "none"}` : `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`PostgREST did not serve ${newest} within 90 s (${last}).`);
}
