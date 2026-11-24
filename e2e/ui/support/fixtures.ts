import { test as base, expect } from "@playwright/test";
import { answerStepUps } from "./auth";
import { storageStatePath } from "./state";

/**
 * The flows' test: signed in as the owner (the browser state 02-signin saved), and any "Confirm it's
 * you" step-up answered with the owner's password and a fresh authenticator code.
 */
export const test = base.extend({
  storageState: async ({}, provide) => provide(storageStatePath()),
  page: async ({ page }, provide) => {
    await answerStepUps(page);
    await provide(page);
  },
});

export { expect };
