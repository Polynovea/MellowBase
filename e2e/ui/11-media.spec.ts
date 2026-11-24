import { auditScreen, tabTo } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { writeState } from "./support/state";
import { errorBanner, expectEmptyState, PNG_1X1 } from "./support/ui";

// Media: the empty state, a refused file, an upload from the keyboard, and the asset's details with
// its "where used" list (empty until 12-entries puts the image on an entry, which checks it again).

test.describe.configure({ mode: "serial" });
const FILE = "ui-test-hero.png";

test("the media library has an empty state", async ({ page }) => {
  await expectEmptyState(page, "/admin/media", "/api/assets", "A home for every asset");
});

test("a file of the wrong kind is refused with a message", async ({ page }) => {
  await page.goto("/admin/media");
  await page.getByLabel("Upload asset").setInputFiles({ name: "notes.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ not really a program") });
  await expect(errorBanner(page).first()).toBeVisible();
});

test("an image is uploaded from the keyboard and its details say where it is used", async ({ page }) => {
  await page.goto("/admin/media");
  const upload = page.getByLabel("Upload asset");
  await tabTo(page, upload);
  // The input itself is visually hidden; its button shows the focus ring.
  await expect(page.locator("label", { has: upload })).toHaveCSS("outline-style", "solid");
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/assets" && r.request().method() === "POST"),
    upload.setInputFiles({ name: FILE, mimeType: "image/png", buffer: PNG_1X1 }),
  ]);
  expect(response.status()).toBeLessThan(300);
  const assetId = ((await response.json()) as { data: { id: string } }).data.id;
  writeState({ assetId, assetFilename: FILE });
  await expect(page.locator(".ui-alert-success")).toContainText(`Asset "${FILE}" uploaded successfully.`);

  const card = page.getByRole("button", { name: new RegExp(`^Open ${FILE.replace(".", "\\.")}`) });
  await tabTo(page, card);
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: FILE });
  await expect(details).toBeVisible();
  await expect(details.getByText("No content entries currently reference this asset.")).toBeVisible();
  await auditScreen(page, "media-details");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await auditScreen(page, "media");
});
