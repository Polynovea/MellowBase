import { auditScreen } from "./support/audit";
import { expect, test } from "./support/fixtures";

// The System page: the health checks (what `polynovea-cms doctor` reports), backups and restore tests,
// and the upgrade screen. No real upgrade: this server has no upgrade agent and no release channel,
// and the page must say so plainly instead of offering a button that cannot work.

test("System shows the health checks, backups, restore tests and a safe upgrade screen", async ({ page }) => {
  await page.goto("/admin/system");
  await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible();

  const health = page.getByRole("region", { name: "Health" });
  await expect(health.getByRole("listitem").first()).toBeVisible();
  for (const name of ["Database", "Backups", "Database migrations"]) await expect(health.getByText(name, { exact: true })).toBeVisible();

  const upgrades = page.getByRole("region", { name: "Upgrades" });
  await expect(upgrades).toContainText("Running release:");
  await expect(upgrades).toContainText("This server has no upgrade agent");
  await upgrades.getByRole("button", { name: "Check for updates" }).click();
  await expect(upgrades).toContainText(/No release channel is set|newest signed release|could not/i);
  await expect(upgrades.getByRole("button", { name: /^Upgrade to/ })).toHaveCount(0);

  const restore = page.getByRole("region", { name: "Restore tests" });
  await expect(restore).toContainText(/No restore test has run yet|Restore|backup/i);
  await auditScreen(page, "system");
});
