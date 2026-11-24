import { auditScreen, tabTo } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { readState, writeState } from "./support/state";
import { expectEmptyState } from "./support/ui";

// Entries: the empty state, a required field left empty, an entry written from the keyboard with the
// uploaded image, an edit, a preview, then submit for review → approve → publish. Approving your own
// submission is refused by default; on a one-person install the owner turns on self-approval in
// Workflows, which the error message points to. Last, the image's "where used" lists the entry.

test.describe.configure({ mode: "serial" });
const TITLE = "UI test entry";

test("the records list has an empty state", async ({ page }) => {
  await expectEmptyState(page, "/admin/entries", /^\/api\/content-search/, "No records match this view");
});

test("an entry is created from the keyboard; a missing required field is caught first", async ({ page }) => {
  const { assetFilename } = readState();
  await page.goto("/admin/entries/new");
  await page.getByRole("button", { name: /UI Test Article/ }).click();
  await expect(page.getByRole("heading", { name: /new ui test article/i })).toBeVisible();
  await auditScreen(page, "entry-new");

  const title = page.getByLabel(/^Title/);
  await page.getByRole("button", { name: "Create draft" }).click();
  expect(await title.evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("");
  await expect(page).toHaveURL(/\/admin\/entries\/new\//);

  await tabTo(page, title);
  await page.keyboard.type(TITLE);
  await tabTo(page, page.getByRole("button", { name: new RegExp(assetFilename!.replace(/\.png$/, "")) }).first());
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByLabel(/^Strapline/));
  await page.keyboard.type("First draft");
  await tabTo(page, page.getByLabel("Change summary"));
  await page.keyboard.type("First draft from the UI test");
  await tabTo(page, page.getByRole("button", { name: "Create draft" }));
  await page.keyboard.press("Enter");

  await page.waitForURL(/\/admin\/entries\/[0-9a-f-]{36}$/);
  writeState({ entryId: page.url().split("/").pop()! });
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Draft created." })).toBeVisible();
});

test("edit, preview, submit for review, approve, publish", async ({ page, context }) => {
  test.setTimeout(4 * 60_000);
  const { entryId } = readState();
  await page.goto(`/admin/entries/${entryId}`);
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await auditScreen(page, "entry-editor");

  // Edit: a second draft version, with a success message.
  await page.getByLabel(/^Title/).fill(`${TITLE} (edited)`);
  await page.getByLabel("Change summary").fill("Edited by the UI test");
  await page.getByRole("button", { name: "Save new draft version" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft version 2 saved." })).toBeVisible();
  await expect(page.getByText("Version 2", { exact: false }).first()).toBeVisible();

  // Preview: a private link opens in a new tab with the saved draft.
  const [preview] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Open preview" }).click()]);
  await preview.waitForLoadState();
  expect(new URL(preview.url()).pathname).toMatch(/^\/preview\//);
  await expect(preview.getByText(`${TITLE} (edited)`).first()).toBeVisible();
  await auditScreen(preview, "entry-preview");
  await preview.close();

  // Submit for review.
  await page.getByLabel("Note to the reviewer").fill("Ready for review");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("button", { name: "Approve stage" })).toBeVisible();

  // Approving your own submission is refused, and the message says where to change that.
  await page.getByRole("button", { name: "Approve stage" }).click();
  const refusal = page.getByRole("alert").filter({ hasText: /approve their own/i });
  await expect(refusal).toBeVisible();
  await expect(refusal.getByRole("link", { name: /Workflows/ })).toBeVisible();

  await page.goto("/admin/workflows");
  await page.getByRole("button", { name: /Default editorial workflow/ }).click();
  await page.getByLabel("Allow requester self-approval").check();
  await page.getByRole("button", { name: "Save workflow" }).click();
  await expect(page.locator(".ui-alert-success")).toBeVisible();
  await auditScreen(page, "workflows");

  await page.goto(`/admin/entries/${entryId}`);
  await page.getByRole("button", { name: "Approve stage" }).click();
  await expect(page.getByRole("heading", { name: "Approved for publication" })).toBeVisible();

  // Publish.
  await page.getByRole("button", { name: "Publish draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
  await expect(page.getByText("published", { exact: true }).first()).toBeVisible();
});

test("the image's details now list the entry that uses it", async ({ page }) => {
  const { assetFilename } = readState();
  await page.goto("/admin/media");
  await page.getByRole("button", { name: new RegExp(`^Open ${assetFilename!.replace(".", "\\.")}`) }).click();
  const details = page.getByRole("dialog", { name: assetFilename! });
  await expect(details.getByText("Used in 1 entry")).toBeVisible();
  await expect(details.getByText(`${TITLE} (edited)`)).toBeVisible();
});
