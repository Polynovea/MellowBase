import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Dual-backend tests: each *.dual.test.ts runs against Supabase (PostgREST) and plain PostgreSQL.
// Needs the local databases from `node scripts/dev-db/setup.mjs`. Run with `npm run test:dual`.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.dual.test.ts"],
    exclude: ["node_modules/**", ".next/**", ".worktrees/**", ".claude/**"],
    setupFiles: ["./lib/db/testing/dualSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
