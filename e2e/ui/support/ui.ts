import { expect, type Page } from "@playwright/test";

/**
 * Opens `url` while the list API behind it answers with no rows, and checks the screen's empty state
 * says something useful. The seeded run always has data, so this is the only way to see these states.
 */
export async function expectEmptyState(page: Page, url: string, api: string | RegExp, text: string | RegExp): Promise<void> {
  // One matcher object for route() and unroute(): unroute only removes a route registered with the same one.
  const matcher = typeof api === "string" ? (u: URL) => u.pathname === api : (u: URL) => api.test(u.pathname + u.search);
  const handler = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: [], error: null, timestamp: new Date().toISOString() }) });
  };
  await page.route(matcher, handler);
  try {
    await page.goto(url);
    await expect(page.getByText(text).first()).toBeVisible();
  } finally {
    await page.unroute(matcher, handler);
  }
}

/** The success banner of an admin screen (ui-alert-success or role=status). */
export const successBanner = (page: Page) => page.locator(".ui-alert-success, [role='status'], .border-success.bg-success-muted");

/** The error banner of an admin screen. */
export const errorBanner = (page: Page) => page.locator(".ui-alert-danger, [role='alert']:not(#__next-route-announcer__), .border-danger.bg-danger-muted");

/** Waits for a POST/PUT to `path` and returns its status. */
export async function responseTo(page: Page, path: string | RegExp, action: () => Promise<unknown>, method = "POST"): Promise<number> {
  const matches = (url: string) => (typeof path === "string" ? new URL(url).pathname === path : path.test(new URL(url).pathname));
  const [response] = await Promise.all([page.waitForResponse((r) => matches(r.url()) && r.request().method() === method), action()]);
  return response.status();
}

/** A tiny valid PNG (1x1), for uploads. */
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/**
 * On a one-person install the owner must be allowed to approve their own submissions (Workflows →
 * "Allow requester self-approval"). Turns it on through the Workflows screen if it is off, so each
 * flow that approves can run on its own.
 */
export async function allowSelfApproval(page: Page): Promise<void> {
  await page.goto("/admin/workflows");
  await page.getByRole("button", { name: /Default editorial workflow/ }).click();
  const box = page.getByLabel("Allow requester self-approval");
  await expect(box).toBeVisible();
  if (await box.isChecked()) return;
  await box.check();
  await page.getByRole("button", { name: "Save workflow" }).click();
  await expect(page.locator(".ui-alert-success")).toBeVisible();
}
