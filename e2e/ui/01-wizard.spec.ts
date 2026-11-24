import { expect, test, type Page } from "@playwright/test";
import { auditScreen, expectVisibleFocus, tabTo } from "./support/audit";
import { totpFor } from "./support/auth";
import { writeState } from "./support/state";
import { errorBanner } from "./support/ui";

// The setup wizard, start to finish, mostly from the keyboard: the setup code, the owner account
// (password, authenticator app, passkey through Chromium's virtual authenticator, recovery codes),
// the organisation, the keys to keep, and Finish. Each step also gets a wrong answer first, and is
// screenshotted and checked with axe in all four views while it is on screen (the wizard closes for
// good at the end, so the audit project cannot come back to it).
//
// Needs a fresh server in setup mode whose database is configured and migrated but has no owner
// (scripts/ui-test/run.mjs starts one), and UI_SETUP_CODE: that server's POLYNOVEA_SETUP_CODE.

const setupCode = process.env.UI_SETUP_CODE;
test.skip(!setupCode, "Set UI_SETUP_CODE (scripts/ui-test/run.mjs does)");
test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const ownerAccount = { email: `owner-${suffix}@example.test`, name: "UI Test Owner", password: `ui test owner passphrase ${suffix}` };

async function passkeyDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** Tabs to a control and activates it with Enter, the way a keyboard user would. */
async function press(page: Page, name: string | RegExp): Promise<void> {
  const button = page.getByRole("button", { name });
  await tabTo(page, button);
  await page.keyboard.press("Enter");
}

test("a fresh install reaches a signed-in owner through the wizard, by keyboard", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  await passkeyDevice(page);

  // Step 1: the setup code. The button waits for a code; a wrong code says what to do.
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Enter the setup code" })).toBeVisible();
  await expect(page.getByRole("button", { name: /continue/i })).toBeDisabled();
  await expect(page.getByText(/You're using this/)).toBeVisible();
  await auditScreen(page, "wizard-1-setup-code");

  const codeBox = page.getByLabel("Setup code");
  await tabTo(page, codeBox);
  await page.keyboard.type("0000-0000-0000-0000-0000-0000-00");
  await page.keyboard.press("Enter");
  await expect(page.locator("#setup-code-error")).toContainText("That code didn't work");
  await expect(codeBox).toHaveAttribute("aria-invalid", "true");

  await codeBox.fill("");
  await page.keyboard.type(setupCode!.toLowerCase());
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Code accepted");
  // The database is configured and migrated already, so the wizard skips its database step.
  await page.waitForURL("**/setup/owner");

  // Step 3a: the owner's details. Mismatched passwords are caught before anything is sent.
  await expect(page.getByRole("heading", { name: "Your owner account" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Owner account steps" })).toBeVisible();
  await auditScreen(page, "wizard-2-owner-details");
  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type(ownerAccount.email);
  await page.keyboard.press("Tab");
  await expectVisibleFocus(page.getByLabel("Your name"));
  await page.keyboard.type(ownerAccount.name);
  await page.keyboard.press("Tab");
  await page.keyboard.type(ownerAccount.password);
  await page.keyboard.press("Tab");
  await page.keyboard.type(`${ownerAccount.password}-typo`);
  await page.keyboard.press("Enter");
  await expect(errorBanner(page).filter({ hasText: "The two passwords don't match." })).toBeVisible();
  await page.getByLabel("Password again").fill(ownerAccount.password);
  await page.getByLabel("Password again").press("Enter");

  // Step 3b: the authenticator app. A wrong code is refused with a fix.
  await press(page, "Show the QR code");
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await auditScreen(page, "wizard-3-authenticator");
  const totpKey = (await page.locator("code").first().textContent())!.trim();
  writeState({ owner: { ...ownerAccount, totpKey, recoveryCodes: [] } });
  const totpBox = page.getByLabel("Code from the app");
  await tabTo(page, totpBox);
  const right = await totpFor(totpKey);
  await page.keyboard.type(right === "000000" ? "111111" : "000000");
  await page.keyboard.press("Enter");
  await expect(errorBanner(page).filter({ hasText: "That code didn't match" })).toBeVisible();
  await totpBox.fill(await totpFor(totpKey));
  await totpBox.press("Enter");

  // Step 3c: the passkey, on the virtual authenticator.
  await expect(page.getByRole("heading", { name: "Add a passkey" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Your passkey only works on this address.");
  await auditScreen(page, "wizard-4-passkey");
  await press(page, "Add a passkey");

  // Step 3d: recovery codes; confirming with the wrong one is refused.
  await press(page, "Show my recovery codes");
  const items = await page.locator("ol li").allTextContents();
  const recoveryCodes = items.map((text) => text.replace(/^\s*\d+\.\s*/, "").trim()).filter((text) => /^[A-Za-z0-9]{5}-[A-Za-z0-9]{7}$/.test(text));
  expect(recoveryCodes).toHaveLength(10);
  writeState({ owner: { ...ownerAccount, totpKey, recoveryCodes } });
  await auditScreen(page, "wizard-5-recovery-codes");
  const confirmBox = page.getByLabel(/Type code number \d+/);
  const number = Number((await page.locator(`label[for="${await confirmBox.getAttribute("id")}"]`).textContent())!.match(/number (\d+)/)![1]);
  await tabTo(page, confirmBox);
  await page.keyboard.type(recoveryCodes[number % 10]);
  await page.keyboard.press("Enter");
  await expect(errorBanner(page).filter({ hasText: `That isn't code number ${number}` })).toBeVisible();
  await confirmBox.fill(recoveryCodes[number - 1]);
  await confirmBox.press("Enter");

  // Step 4a: the organisation. Starter content stays on: the later flows use it.
  await expect(page.getByRole("heading", { name: "Your organisation" })).toBeVisible();
  await auditScreen(page, "wizard-6-organisation");
  await tabTo(page, page.getByLabel("Organisation name"));
  await page.keyboard.type("UI Test Organisation");
  await page.keyboard.press("Tab");
  await page.keyboard.type("UI Test Workspace");
  const starter = page.getByRole("checkbox", { name: /starter content/i });
  if (!(await starter.isChecked())) await starter.check();
  await page.getByLabel("Workspace name").press("Enter");

  // Step 4b: the keys to keep (only those this install has).
  await press(page, "Show my keys");
  await auditScreen(page, "wizard-7-keys");
  for (const [field, block] of [["Last 6 characters of the master key", "Master key"], ["Last 6 characters of the backup password", "Backup password"]] as const) {
    if (await page.getByLabel(field).count()) {
      const value = (await page.locator("div", { hasText: block }).locator("code").first().textContent())!.trim();
      await page.getByLabel(field).fill(value.slice(-6));
    }
  }
  await press(page, /I've saved them|Continue/);

  // Finish: one transaction, then the sign-in page.
  await expect(page.getByRole("heading", { name: "Finish setup" })).toBeVisible();
  await auditScreen(page, "wizard-8-finish");
  await press(page, "Finish setup");
  await expect(page.getByRole("status")).toContainText("Setup is finished");
  await page.waitForURL("**/admin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect((await page.context().cookies()).some((cookie) => cookie.name === "__Host-polynovea-setup")).toBe(false);
});

test("after setup the wizard is gone for good", async ({ request }) => {
  expect((await request.get("/setup")).status()).toBe(404);
  expect((await request.get("/setup/owner")).status()).toBe(404);
});
