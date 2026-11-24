import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { auditScreen, RESULTS_DIR, type ScreenResult } from "./support/audit";
import { expect, test } from "./support/fixtures";
import { readState } from "./support/state";

// Every main screen of the admin app, in four views (390 px and 1440 px, light and dark): screenshots,
// axe, sideways scrolling and the tab title (support/audit.ts). The screens the flows already audited
// mid-flow (wizard steps, model editor, entry editor, release detail, media details, ...) are not
// repeated. Then every same-site link seen on any screen is opened, to find broken ones.

const screens: Array<[name: string, url: string | (() => string)]> = [
  ["command-center", "/admin/cms"],
  ["experience-studio", "/admin/experience"],
  ["blog", "/admin/blog"],
  ["blog-new", "/admin/blog/new"],
  ["entries", "/admin/entries"],
  ["entries-import", "/admin/entries/import"],
  ["entry-choose-model", "/admin/entries/new"],
  ["entry-visual-studio", () => `/admin/entries/${readState().entryId}/experience`],
  ["models", "/admin/models"],
  ["taxonomy", "/admin/taxonomy"],
  ["routes", "/admin/routes"],
  ["redirects", "/admin/redirects"],
  ["navigation", "/admin/navigation"],
  ["releases", "/admin/releases"],
  ["my-work", "/admin/my-work"],
  ["metrics", "/admin/metrics"],
  ["assurance", "/admin/assurance"],
  ["delivery-ops", "/admin/operations"],
  ["content-intelligence", "/admin/intelligence"],
  ["operational-intelligence", "/admin/operational-intelligence"],
  ["environments", "/admin/environments"],
  ["connections", "/admin/connections"],
  ["infrastructure", "/admin/infrastructure"],
  ["access", "/admin/access"],
  ["profile", "/admin/profile"],
  ["sign-in-security", "/admin/security"],
];

for (const [name, url] of screens) {
  test(`screen: ${name}`, async ({ page }) => {
    await page.goto(typeof url === "string" ? url : url());
    await expect(page.locator("main h1, h1").first()).toBeVisible();
    await auditScreen(page, name);
  });
}

test("the mobile navigation opens, lists every section, and closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/cms");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "System" })).toBeVisible();
  await auditScreen(page, "mobile-navigation");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Close navigation" }).last().click();
  await expect(page.getByRole("link", { name: "System" })).toBeHidden();
});

test("no same-site link on any audited screen is broken", async ({ page }) => {
  const links = new Set<string>();
  for (const file of readdirSync(RESULTS_DIR).filter((name) => name.endsWith(".json"))) {
    for (const link of (JSON.parse(readFileSync(path.join(RESULTS_DIR, file), "utf8")) as ScreenResult).links) links.add(link);
  }
  const broken: string[] = [];
  for (const link of links) {
    if (link.startsWith("/preview/")) continue; // one-time preview links, opened by the entries flow
    const status = (await page.request.get(link, { maxRedirects: 5 })).status();
    if (status >= 400) broken.push(`${status} ${link}`);
  }
  expect(broken).toEqual([]);
});
