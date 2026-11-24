import { auditScreen } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { readState, writeState } from "./support/state";
import { expectEmptyState } from "./support/ui";

// Releases and the calendar: the starter entry is approved, put in a release, the release is approved
// and scheduled, and the calendar shows it. The calendar's own form gets a missing title, then an event
// of a chosen type. Empty states for both lists.

test.describe.configure({ mode: "serial" });
const RELEASE = "UI test release";

test("releases and the calendar have empty states", async ({ page }) => {
  await expectEmptyState(page, "/admin/releases", "/api/releases", "No release is in flight");
  await expectEmptyState(page, "/admin/calendar", "/api/calendar", "No editorial events scheduled");
  await expectEmptyState(page, "/admin/releases/new", "/api/entries", "No approved entries are available yet.");
});

test("the starter entry is approved, released, scheduled, and shows in the calendar", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const { starterEntryId } = readState();
  await page.goto(`/admin/entries/${starterEntryId}`);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve stage" }).click();
  await expect(page.getByRole("heading", { name: "Approved for publication" })).toBeVisible();

  await page.goto("/admin/releases/new");
  const create = page.getByRole("button", { name: "Create draft release" });
  await expect(create).toBeDisabled();
  await page.getByLabel("Release name").fill(RELEASE);
  await page.getByLabel("Purpose").fill("Checks the release and calendar screens");
  await page.getByRole("button", { name: /Welcome to Polynovea/ }).click();
  await expect(page.getByText("1 selected")).toBeVisible();
  await auditScreen(page, "release-new");
  await create.click();

  await page.waitForURL(/\/admin\/releases\/[0-9a-f-]{36}$/);
  writeState({ releaseId: page.url().split("/").pop()!, releaseEntryId: starterEntryId });
  await expect(page.getByRole("heading", { level: 1, name: RELEASE })).toBeVisible();
  await expect(page.getByText("Ready for controlled publication")).toBeVisible();
  await page.getByRole("button", { name: "Approve release" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Release approved." })).toBeVisible();

  // Scheduling needs a date; two days ahead keeps it in the future for the whole run.
  const schedule = page.getByRole("button", { name: "Schedule" });
  await expect(schedule).toBeDisabled();
  const when = new Date(Date.now() + 2 * 24 * 3600_000);
  when.setMinutes(0, 0, 0);
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel("Publish date & time").fill(local);
  await schedule.click();
  await expect(page.getByRole("status").filter({ hasText: "Release scheduled." })).toBeVisible();
  await expect(page.getByText("scheduled", { exact: true }).first()).toBeVisible();
  await auditScreen(page, "release-detail");

  await page.goto("/admin/calendar");
  const event = page.locator(".ui-list-row").filter({ hasText: RELEASE });
  await expect(event).toBeVisible();
  await expect(event).toContainText("release");
});

test("the calendar's own form: a missing title is caught, then an event of a chosen type is scheduled", async ({ page }) => {
  await page.goto("/admin/calendar");
  const submit = page.getByRole("button", { name: "Schedule" });
  await submit.click();
  expect(await page.getByLabel("Event").evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("");

  await page.getByLabel("Event").fill("UI test publish slot");
  await page.getByLabel("Type").selectOption({ label: "publish" });
  const when = new Date(Date.now() + 3 * 24 * 3600_000);
  await page.getByLabel("When").fill(new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await submit.click();
  await expect(page.locator(".ui-alert-success")).toContainText("Event scheduled.");
  await expect(page.locator(".ui-list-row").filter({ hasText: "UI test publish slot" })).toContainText("publish");
  await auditScreen(page, "calendar");
});
