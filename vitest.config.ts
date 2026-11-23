import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "ui-ux-pro-max-skill/**", ".worktrees/**", ".claude/**", "**/*.dual.test.ts", "**/*.azurite.test.ts"],
    // The shell's auth settings never reach unit tests; tests that need them set their own.
    setupFiles: ["./lib/auth/testing/unitAuthEnv.ts"],
  },
});
