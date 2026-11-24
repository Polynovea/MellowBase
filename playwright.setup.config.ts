import { defineConfig, devices } from "@playwright/test";

// Browser tests for the setup wizard (e2e/setup, Phase 2 acceptance tests 1 to 6). Unlike
// playwright.config.ts, this starts no server and creates no owner: each spec needs its own server in
// setup mode, started by hand as its header describes, and finishing setup closes the wizard for good.
//
//   npx playwright test -c playwright.setup.config.ts e2e/setup/<spec>.spec.ts
//
// E2E_SETUP_BASE_URL, E2E_SETUP_CODE and the other variables each spec lists say where that server is.

export default defineConfig({
  testDir: "./e2e/setup",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_SETUP_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) } }],
});
