import { auditScreen } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { readState, writeState } from "./support/state";
import { errorBanner, expectEmptyState } from "./support/ui";

// Translations: the locale list's empty state, a refused locale code, adding Hindi, then translating the
// published entry from its Translations panel and seeing the translation linked back.

test.describe.configure({ mode: "serial" });

test("locales: empty state, a bad code refused, Hindi added", async ({ page }) => {
  await expectEmptyState(page, "/admin/localization", "/api/locales", "No locales are set up yet");

  await page.goto("/admin/localization");
  const code = page.getByLabel("Locale code");
  await code.fill("not a locale!!");
  await page.getByRole("button", { name: "Add enabled locale" }).click();
  await expect(errorBanner(page).first()).toBeVisible();

  await code.fill("hi");
  await page.getByRole("button", { name: "Add enabled locale" }).click();
  await expect(page.locator(".ui-alert-success")).toContainText("hi locale policy saved.");
  // The new row's code (the fallback dropdowns also hold an "hi" option, which is never visible text).
  await expect(page.getByText("hi", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await auditScreen(page, "localization");
});

test("the published entry is translated into Hindi and the translation is linked back", async ({ page }) => {
  const { entryId } = readState();
  await page.goto(`/admin/entries/${entryId}`);
  const panel = page.getByRole("region", { name: "Translations" });
  const hindi = panel.locator("div.rounded-lg").filter({ hasText: /^hi/ });
  await expect(hindi).toContainText("Missing");
  await hindi.getByRole("link", { name: "Create translation" }).click();

  await expect(page.getByText(/hi translation draft/i)).toBeVisible();
  await page.getByLabel(/^Title/).fill("UI test entry (Hindi)");
  await page.getByRole("button", { name: "Create hi translation" }).click();
  await page.waitForURL(/\/admin\/entries\/[0-9a-f-]{36}$/);
  const translationEntryId = page.url().split("/").pop()!;
  expect(translationEntryId).not.toBe(entryId);
  writeState({ translationEntryId });

  await page.goto(`/admin/entries/${entryId}`);
  await expect(hindi).toContainText("Draft");
  await expect(hindi.getByRole("link", { name: "Edit hi" })).toHaveAttribute("href", `/admin/entries/${translationEntryId}`);
});
