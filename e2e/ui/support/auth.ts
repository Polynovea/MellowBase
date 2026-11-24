import { expect, type Page } from "@playwright/test";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { owner, readState, writeState } from "./state";

const PERIOD_SECONDS = 30;

/** A code for the given authenticator key at this moment (no replay bookkeeping). */
export async function totpFor(key: string): Promise<string> {
  return createOTP(base32.decode(key), { digits: 6, period: PERIOD_SECONDS }).totp();
}

/**
 * The owner's next authenticator code. A code is never sent twice: when this 30-second step was
 * already used (a sign-in, a step-up or seed:starter), it waits for the next step first.
 */
export async function nextOwnerCode(): Promise<string> {
  const current = owner();
  let step = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  if (current.lastTotpStep !== undefined && step <= current.lastTotpStep) {
    const waitMs = (current.lastTotpStep + 1) * PERIOD_SECONDS * 1000 - Date.now() + 1_000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    step = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  }
  const code = await totpFor(current.totpKey);
  writeState({ owner: { ...readState().owner!, lastTotpStep: step } });
  return code;
}

/** Signs the owner in through the sign-in screen: password, then the authenticator code. */
export async function signInAsOwner(page: Page): Promise<void> {
  const { email, password } = owner();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  // Exactly "Sign in": the screen also has "Sign in with a passkey".
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.getByLabel("Code from your authenticator app").fill(await nextOwnerCode());
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /CMS WORKSPACE/i })).toBeVisible();
}

/**
 * Answers the "Confirm it's you" dialog whenever a sensitive action asks for a fresh sign-in
 * (API tokens, confirming a deletion): password, then the authenticator code. The action is then
 * retried by the page itself.
 */
export async function answerStepUps(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await page.addLocatorHandler(dialog, async () => {
    await dialog.getByLabel("Password").fill(owner().password);
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await dialog.getByLabel("Code from your authenticator app").fill(await nextOwnerCode());
    await dialog.getByRole("button", { name: "Verify" }).click();
    await expect(dialog).toBeHidden();
  });
}
