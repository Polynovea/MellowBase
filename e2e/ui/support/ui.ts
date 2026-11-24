import { expect, type Page } from "@playwright/test";

/**
 * Opens `url` while the list API behind it answers with no rows, and checks the screen's empty state
 * says something useful. The seeded run always has data, so this is the only way to see these states.
 */
export async function expectEmptyState(page: Page, url: string, api: string | RegExp, text: string | RegExp): Promise<void> {
  const pattern = typeof api === "string" ? (u: URL) => u.pathname === api : (u: URL) => api.test(u.pathname + u.search);
  const handler = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: [], error: null, timestamp: new Date().toISOString() }) });
  };
  await page.route((u) => pattern(u), handler);
  try {
    await page.goto(url);
    await expect(page.getByText(text).first()).toBeVisible();
  } finally {
    await page.unroute((u) => pattern(u), handler);
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
