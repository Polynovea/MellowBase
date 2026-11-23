import { defineConfig } from "vitest/config";
import dual from "./vitest.dual.config";

// The existing content dual tests with every model's current-content reads switched to its model table
// (phase 3). lib/content/testing/tableReads.setup.ts brings each model's table up the production way
// as tests create or change models. Run with `npm run test:dual:tables` (same database stack as
// test:dual). Spread, not mergeConfig: mergeConfig would append to the base include list.
const base = dual.test ?? {};
export default defineConfig({
  ...dual,
  test: {
    ...base,
    include: [
      "lib/content/entryService.dual.test.ts",
      "lib/content/publicationService.dual.test.ts",
      "lib/content/searchService.dual.test.ts",
      "lib/content/releaseService.dual.test.ts",
      "lib/developer/**/*.dual.test.ts",
    ],
    setupFiles: [...((base.setupFiles as string[] | undefined) ?? []), "./lib/content/testing/tableReads.setup.ts"],
    testTimeout: 60_000,
  },
});
