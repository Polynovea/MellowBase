import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Dual-backend tests: each *.dual.test.ts runs against Supabase (PostgREST) and plain PostgreSQL.
// Needs the local stack from `node scripts/dev-db/setup.mjs` (databases and Azurite). Run with `npm run test:dual`.
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
    exclude: ["node_modules/**", ".next/**", ".worktrees/**", ".claude/**"],
    // Once per run: both databases on the newest migration and PostgREST serving it.
    globalSetup: ["./lib/db/testing/dualGlobalSetup.ts"],
    setupFiles: ["./lib/db/testing/dualSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
