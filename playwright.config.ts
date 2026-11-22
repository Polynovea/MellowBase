import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Browser tests against a production build (next build + next start), wired to the local
// Supabase-compatible stack from `node scripts/dev-db/setup.mjs` (PostgREST + GoTrue on 127.0.0.1).
// Run with `npm run test:e2e`. The same sign-in test runs against built-in auth once phase 1 lands.

function loadTestEnv(): Record<string, string> {
  const file = path.resolve(process.cwd(), ".env.test.local");
  if (!existsSync(file)) throw new Error("Missing .env.test.local. Run node scripts/dev-db/setup.mjs first.");
  const values: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (line && !line.startsWith("#") && eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

const testEnv = loadTestEnv();
const PORT = 3100;
export const appEnv = {
  NEXT_PUBLIC_SUPABASE_URL: testEnv.POLYNOVEA_TEST_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: testEnv.POLYNOVEA_TEST_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: testEnv.POLYNOVEA_TEST_SUPABASE_SERVICE_ROLE_KEY,
  DATABASE_URL: testEnv.POLYNOVEA_TEST_SUPABASE_DB_URL,
};
Object.assign(process.env, appEnv);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  // PLAYWRIGHT_CHANNEL picks an installed browser (msedge, chrome) so a local run needs no download;
  // unset, Playwright's own Chromium is used (`npx playwright install chromium`), as on CI and Linux.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) } }],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/admin`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: appEnv,
  },
});
