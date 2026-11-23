import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database integration tests (*.dual.test.ts, the name they had while both backends existed) against
// plain PostgreSQL, plus the Azurite storage tests. Needs the local stack from
// `node scripts/dev-db/setup.mjs` (PostgreSQL and Azurite). Run with `npm run test:dual`.
//
// A few tests need the Supabase compatibility services (`setup.mjs --with-supabase`): they check
// that a Supabase install still takes the migrations and that GoTrue users import into the built-in
// auth. Without those services they are left out, and the run says so.
const SUPABASE_ONLY = ["lib/auth/authMigrate.dual.test.ts"];
const envFile = fileURLToPath(new URL(".env.test.local", import.meta.url));
const supabaseConfigured = existsSync(envFile) && /^POLYNOVEA_TEST_SUPABASE_DB_URL=./m.test(readFileSync(envFile, "utf8"));
if (!supabaseConfigured) {
  console.warn(`[test:dual] Supabase compatibility services are not running; leaving out ${SUPABASE_ONLY.join(", ")} and the Supabase catalog checks. Start them with: node scripts/dev-db/setup.mjs --with-supabase`);
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Azurite (Azure Blob emulator) tests run here too: setup.mjs starts Azurite with the databases.
    include: ["**/*.dual.test.ts", "**/*.azurite.test.ts"],
    exclude: ["node_modules/**", ".next/**", ".worktrees/**", ".claude/**", ...(supabaseConfigured ? [] : SUPABASE_ONLY)],
    // Once per run: the databases on the newest migration.
    globalSetup: ["./lib/db/testing/dualGlobalSetup.ts"],
    setupFiles: ["./lib/db/testing/dualSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
