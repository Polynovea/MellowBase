import { auditScreen } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { readState } from "./support/state";
import { errorBanner, expectEmptyState } from "./support/ui";

// API tokens: the empty list, a refused rate limit, then a token limited to one model and read-only
// scopes. The secret is shown once; the token reads its model and is refused the other one.
// AI agents: the brief asks for an agent limited to some fields. The CMS has agent identities in its
// API layer (lib/developer/agentGovernanceService.ts) but no screen or admin route to create one, so
// that test is marked fixme until that decision is made (docs/ui-audit/report.md, "blocks a user").

test.describe.configure({ mode: "serial" });

test("the token list has an empty state", async ({ page }) => {
  await expectEmptyState(page, "/admin/developer", "/api/developer/tokens", "No API tokens issued.");
});

test("a token limited to one model: a bad rate limit is refused, then it is created and works only for that model", async ({ page, request }) => {
  const { modelApiKey } = readState();
  await page.goto("/admin/developer");
  await expect(page.getByRole("heading", { name: "API & Schema Delivery" })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill("UI test website");
  await page.getByLabel("Requests / minute").fill("0");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(errorBanner(page).first()).toContainText("Rate limit must be between 1 and 10000 requests per minute");

  await page.getByLabel("Requests / minute").fill("60");
  await page.getByRole("checkbox", { name: new RegExp(modelApiKey!) }).check();
  await page.getByRole("button", { name: "Create token" }).click();
  const secretBox = page.locator(".ui-alert-warning code");
  await expect(page.getByText("New API secret — copy it now")).toBeVisible();
  const secret = (await secretBox.textContent())!.trim();
  expect(secret).toMatch(/^pnv_/);
  await expect(page.getByRole("button", { name: "Copy the secret" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "UI test website" })).toContainText(modelApiKey!);
  await auditScreen(page, "developer");

  // The quick start shows this server's own address, not a placeholder.
  await expect(page.locator("pre").first()).toContainText(new URL(page.url()).origin);

  const headers = { authorization: `Bearer ${secret}` };
  expect((await request.get(`/api/v1/content/${modelApiKey}?limit=1`, { headers })).status()).toBe(200);
  expect([403, 404]).toContain((await request.get("/api/v1/content/starter_article?limit=1", { headers })).status());
});

test.fixme("an AI agent limited to some fields is created", async () => {
  // No admin screen or route creates agent identities yet: see the comment at the top of this file.
});
