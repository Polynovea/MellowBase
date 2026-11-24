import { expect, test } from "./support/fixtures";

// Sign out last: from the profile menu, the session ends on the server, and the admin app asks for a
// sign-in again even when a page is opened directly.

test("signing out from the profile menu ends the session", async ({ page, context }) => {
  await page.goto("/admin/cms");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.getByRole("button", { name: "Open profile menu" }).click();
  await page.getByRole("button", { name: "Log out" }).last().click();
  await page.waitForURL("**/admin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  const fresh = await context.newPage();
  await fresh.goto("/admin/models");
  await expect(fresh.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const api = await fresh.request.get("/api/models");
  expect([401, 403]).toContain(api.status());
});
