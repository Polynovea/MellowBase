import { defineConfig, devices } from "@playwright/test";

// End-to-end UI tests of the admin app (e2e/ui), on built-in auth, against a production build.
// They start no server: scripts/ui-test/run.mjs builds the app, starts it in setup mode on a fresh
// database, runs these projects in order, and stops everything again:
//
//   node scripts/ui-test/run.mjs            (heavy: Docker, a database, a build and a browser)
//
// The projects run one after another, each on what the previous one left:
//   wizard  setup code → owner account (password, authenticator app, passkey, recovery codes) → finish
//   signin  two-step sign-in, then `npm run seed:starter`; saves the signed-in browser state
//   flows   models, media, entries, workflow, releases and calendar, translations, API tokens, System
//   audit   every main screen at 390 px and 1440 px, light and dark: screenshots, axe, overflow, links
//   signout signs out last, so it never ends the session the other projects use
//
// UI_BASE_URL is the server (default http://localhost:3100: passkeys refuse IP addresses, so not
// 127.0.0.1). UI_STATE_DIR is a folder outside the repo where the run keeps the owner's test
// credentials and the signed-in browser state; run.mjs makes a fresh one per run.

const baseURL = process.env.UI_BASE_URL ?? "http://localhost:3100";
const browser = { ...devices["Desktop Chrome"], ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) };

export default defineConfig({
  testDir: "./e2e/ui",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // run.mjs runs each stage on its own (--no-deps) so a failing flow never skips the audit; each
  // stage writes its own JSON report.
  reporter: [["list"], ["json", { outputFile: `test-results/ui/results-${process.env.UI_STAGE ?? "all"}.json` }]],
  outputDir: "test-results/ui/artifacts",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [
    { name: "wizard", testMatch: /01-wizard\.spec\.ts/, use: browser },
    { name: "signin", testMatch: /02-signin\.spec\.ts/, dependencies: ["wizard"], use: browser },
    { name: "flows", testMatch: /1\d-[a-z-]+\.spec\.ts/, dependencies: ["signin"], use: browser },
    { name: "audit", testMatch: /80-audit\.spec\.ts/, dependencies: ["flows"], use: browser },
    { name: "signout", testMatch: /90-signout\.spec\.ts/, dependencies: ["audit"], use: browser },
  ],
});
