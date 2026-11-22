import { expect, test } from "@playwright/test";

test("an owner signs in and opens the dashboard", async ({ page }) => {
  const email = process.env.E2E_OWNER_EMAIL!;
  const password = process.env.E2E_OWNER_PASSWORD!;

  await page.goto("/admin/cms");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
});

test("a wrong password is refused without leaving the sign-in screen", async ({ page }) => {
  await page.goto("/admin/cms");
  await page.locator("#login-email").fill(process.env.E2E_OWNER_EMAIL!);
  await page.locator("#login-password").fill("not the right password");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Command Center" })).toHaveCount(0);
});
