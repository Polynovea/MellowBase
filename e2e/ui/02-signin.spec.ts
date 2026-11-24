import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { auditScreen, tabTo } from "./support/audit";
import { nextOwnerCode } from "./support/auth";
import { owner, storageStatePath, writeState } from "./support/state";

// Two-step sign-in as the owner the wizard created: a wrong password and a wrong code first, each with
// a plain message, then the real sign-in, by keyboard. Then `npm run seed:starter` against the running
// server (idempotent: the wizard already made the starter content), and the signed-in browser state is
// saved for the flows.

test.describe.configure({ mode: "serial" });

test("the sign-in screen refuses a wrong password, then a wrong code, then signs in", async ({ page }) => {
  const { email, password } = owner();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await auditScreen(page, "sign-in");

  // Validation: an empty form is stopped by the browser before it is sent.
  await page.getByRole("button", { name: /^sign in$/i }).click();
  expect(await page.getByLabel("Email").evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("");

  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await page.keyboard.type("not the right password");
  await page.keyboard.press("Enter");
  await expect(page.locator("#signin-error")).toHaveText("That email and password do not match.");

  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Password").press("Enter");
  const codeBox = page.getByLabel("Code from your authenticator app");
  await expect(codeBox).toBeFocused();
  await auditScreen(page, "sign-in-code");
  const right = await nextOwnerCode();
  await page.keyboard.type(right === "000000" ? "111111" : "000000");
  await page.keyboard.press("Enter");
  await expect(page.locator("#signin-error")).toHaveText("That code is not right. Try again.");

  await codeBox.fill(await nextOwnerCode());
  await codeBox.press("Enter");
  await expect(page.getByRole("heading", { name: /CMS WORKSPACE/i })).toBeVisible();
  await auditScreen(page, "gateway");
  await page.context().storageState({ path: storageStatePath() });
});

test("seed:starter signs in with two-step and finds the starter content already there", async () => {
  test.setTimeout(3 * 60_000);
  const { email, password } = owner();
  const output = execFileSync(process.execPath, ["scripts/seed-starter.mjs", `--url=${process.env.UI_BASE_URL ?? "http://localhost:3100"}`, `--email=${email}`], {
    env: { ...process.env, AUTH_PROVIDER: "builtin", POLYNOVEA_BOOTSTRAP_ADMIN_PASSWORD: password, POLYNOVEA_OWNER_OTP: await nextOwnerCode() },
    encoding: "utf8",
    timeout: 120_000,
  });
  const result = JSON.parse(output.slice(output.indexOf("{"))) as { model: { id: string; created: boolean }; entry: { id: string; created: boolean } };
  expect(result.model.id).toBeTruthy();
  expect(result.entry.id).toBeTruthy();
  writeState({ starterModelId: result.model.id, starterEntryId: result.entry.id });
});
