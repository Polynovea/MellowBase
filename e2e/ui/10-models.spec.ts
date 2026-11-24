import { auditScreen } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { readState, writeState } from "./support/state";
import { errorBanner, expectEmptyState } from "./support/ui";
import type { Page } from "@playwright/test";

// Data models: the empty state, a refused duplicate, creating a publishable model, then adding,
// renaming and deleting fields. A deletion waits for the model's API key to be typed; re-adding the
// field while it waits cancels the deletion and keeps its values. Each saved change is applied to the
// database by the schema worker, which run.mjs starts next to the server.

test.describe.configure({ mode: "serial" });
const MODEL = { name: "UI Test Article", apiKey: "ui_test_article" };

const field = (page: Page, label: string) => page.getByRole("group", { name: `Field: ${label}` });

/** Review changes → the migration preview → apply. Returns the preview's classification line. */
async function reviewAndApply(page: Page, expectUnsafe: boolean): Promise<void> {
  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByText("Server-validated migration preview. Nothing has been applied yet.")).toBeVisible();
  const apply = page.getByRole("button", { name: expectUnsafe ? "Acknowledge & apply" : "Apply safe change" });
  await expect(apply).toBeEnabled();
  await apply.click();
}

/** Waits for the schema worker to finish applying (the page refreshes the status by itself). */
async function waitForWorker(page: Page): Promise<void> {
  await expect(page.getByText("Applying your changes to the database")).toBeHidden({ timeout: 60_000 });
}

test("the models list has an empty state", async ({ page }) => {
  await expectEmptyState(page, "/admin/models", "/api/models", "Your schema starts here");
  await expect(page.getByRole("link", { name: "Create first model" })).toBeVisible();
});

test("a duplicate API key is refused, then a publishable model is created", async ({ page }) => {
  await page.goto("/admin/models/new");
  await expect(page.getByRole("heading", { name: /create model/i })).toBeVisible();
  await auditScreen(page, "model-new");

  await page.getByLabel("Model name").fill("Starter Article copy");
  await page.getByLabel("API key").fill("starter_article");
  await page.getByRole("button", { name: /Publishable/ }).click();
  await field(page, "1").getByLabel("Field label").fill("Title");
  await page.getByRole("button", { name: "Create model" }).click();
  await expect(errorBanner(page).first()).toBeVisible();
  await expect(errorBanner(page).first()).toContainText(/starter_article|already|exists|in use|taken/i);
  await expect(page).toHaveURL(/\/admin\/models\/new$/);

  await page.getByLabel("Model name").fill(MODEL.name);
  await page.getByLabel("API key").fill(MODEL.apiKey);
  await field(page, "Title").getByLabel("Required").check();
  await page.getByRole("button", { name: "Add field" }).click();
  await field(page, "2").getByLabel("Field label").fill("Hero image");
  await field(page, "Hero image").getByLabel("Field type").selectOption("media");
  await page.getByRole("button", { name: "Add field" }).click();
  await field(page, "3").getByLabel("Field label").fill("Notes");
  await field(page, "Notes").getByLabel("Field type").selectOption("long_text");
  await page.getByRole("button", { name: "Create model" }).click();

  await page.waitForURL(/\/admin\/models\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: MODEL.name })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: `${MODEL.name} is created` })).toBeVisible();
  writeState({ modelId: page.url().split("/").pop()!, modelApiKey: MODEL.apiKey });
  await waitForWorker(page);
  await auditScreen(page, "model-editor");
});

test("add a field, rename it, delete it, restore it by re-adding, and delete another for good", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const { modelId } = readState();
  await page.goto(`/admin/models/${modelId}`);
  await expect(page.getByRole("heading", { name: MODEL.name })).toBeVisible();

  // Add: a safe change, saved as a new version.
  await page.getByRole("button", { name: "Add field" }).click();
  // Typed key by key, as a person would: the key follows the whole label, not just its first letter.
  await field(page, "4").getByLabel("Field label").pressSequentially("Subtitle");
  await expect(field(page, "Subtitle").getByLabel("Field key")).toHaveValue("subtitle");
  await reviewAndApply(page, false);
  await expect(page.getByRole("status").filter({ hasText: /Saved as version 2/ })).toBeVisible();
  await waitForWorker(page);

  // Rename: the label changes; the saved field's key is locked so its data stays put.
  await expect(field(page, "Subtitle").getByLabel("Field key")).toHaveAttribute("readonly", "");
  await field(page, "Subtitle").getByLabel("Field label").fill("Strapline");
  await reviewAndApply(page, false);
  await expect(page.getByRole("status").filter({ hasText: /Saved as version 3/ })).toBeVisible();
  await waitForWorker(page);
  await page.reload();
  await expect(field(page, "Strapline").getByLabel("Field label")).toHaveValue("Strapline");

  // Delete: unsafe, so it is acknowledged, then it waits for the typed API key.
  await field(page, "Strapline").getByRole("button", { name: "Remove field" }).click();
  await reviewAndApply(page, true);
  await waitForWorker(page);
  const waiting = page.getByText("A deletion is waiting for your confirmation");
  await expect(waiting).toBeVisible();
  await auditScreen(page, "model-deletion-waiting");
  await page.getByRole("button", { name: "Review and confirm" }).click();
  const confirmBox = page.getByRole("dialog", { name: "Confirm deletion" }).getByRole("textbox");
  await confirmBox.fill("not_the_key");
  await expect(page.getByRole("button", { name: "Delete for good" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(waiting).toBeVisible();

  // Restore: re-adding the same key cancels the waiting deletion and keeps the values.
  await page.getByRole("button", { name: "Add field" }).click();
  const readded = field(page, String(await page.getByRole("group", { name: /^Field: / }).count()));
  await readded.getByLabel("Field label").fill("Strapline");
  await readded.getByLabel("Field key").fill("subtitle");
  await reviewAndApply(page, false);
  await expect(page.getByRole("status").filter({ hasText: /Restored "subtitle"/ })).toBeVisible();
  await waitForWorker(page);
  await expect(waiting).toBeHidden();

  // Delete for good: the typed API key confirms it (a step-up may ask for a fresh sign-in first).
  await field(page, "Notes").getByRole("button", { name: "Remove field" }).click();
  await reviewAndApply(page, true);
  await waitForWorker(page);
  await page.getByRole("button", { name: "Review and confirm" }).click();
  await page.getByRole("dialog", { name: "Confirm deletion" }).getByRole("textbox").fill(MODEL.apiKey);
  await page.getByRole("button", { name: "Delete for good" }).click();
  await expect(waiting).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: /deleted/i })).toBeVisible();
  await expect(field(page, "Notes")).toHaveCount(0);
});
