import { expect, test } from "@playwright/test";

/**
 * Acceptance test 2 (implementation plan, Phase 2): five wrong setup codes lock setup; the correct
 * code still works once the lock is over.
 *
 * Needs a server in setup mode (no database configuration, no installation row) started with a known
 * code: POLYNOVEA_SETUP_CODE=<26 base32 characters>, and the same value in E2E_SETUP_CODE for this
 * test. E2E_SETUP_BASE_URL is its address on http://127.0.0.1 (e.g. http://127.0.0.1:3200, server
 * started with -H 127.0.0.1), which the wizard accepts as loopback (the SSH tunnel route). Run it with
 * playwright.setup.config.ts. The lock lasts the real 15 minutes; there is deliberately no test-only
 * shortcut in the server, so this test waits it out.
 */

const base = process.env.E2E_SETUP_BASE_URL;
const SETUP_CODE = process.env.E2E_SETUP_CODE;
const LOCK_MINUTES = 15;
test.use({ baseURL: base });

test.describe("setup code", () => {
  test.skip(!base || !SETUP_CODE, "Set E2E_SETUP_BASE_URL and E2E_SETUP_CODE (start the server in setup mode with POLYNOVEA_SETUP_CODE to the same value)");

  test("five wrong codes lock setup; the right code works after the lock", async ({ page }) => {
    test.setTimeout((LOCK_MINUTES + 5) * 60_000);

    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Enter the setup code" })).toBeVisible();
    const input = page.getByLabel("Setup code");
    const submit = page.getByRole("button", { name: /continue/i });
    // The form's own error. Next.js also renders an (empty) role="alert" route announcer on every page,
    // so a bare getByRole("alert") matches two elements.
    const error = page.locator("#setup-code-error");
    // Submits and waits for the server's answer, so each check sees this attempt's result, not the last one's.
    const attempt = async (value: string) => {
      await input.fill(value);
      const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/setup/code") && r.request().method() === "POST"), submit.click()]);
      return response.status();
    };

    for (let n = 1; n <= 4; n += 1) {
      expect(await attempt(`WRONG-${n}0000-00000-00000-00000`)).toBe(401);
      await expect(error).toContainText("That code didn't work");
    }
    expect(await attempt("WRONG-50000-00000-00000-00000")).toBe(429);
    await expect(error).toContainText("Too many wrong codes");

    // Locked: even the right code is refused, and no setup cookie is set.
    expect(await attempt(SETUP_CODE!)).toBe(429);
    await expect(error).toContainText("Too many wrong codes");
    expect((await page.context().cookies()).some((cookie) => cookie.name === "__Host-polynovea-setup")).toBe(false);

    await page.waitForTimeout(LOCK_MINUTES * 60_000 + 5_000);

    await page.reload();
    await page.getByLabel("Setup code").fill(SETUP_CODE!.toLowerCase());
    await page.getByRole("button", { name: /continue/i }).click();
    await expect(page.getByRole("status")).toContainText("Code accepted");
    await expect.poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === "__Host-polynovea-setup")).toBe(true);
  });

  test("the code in the address is refused and never used", async ({ request }) => {
    const response = await request.post(`/api/setup/code?code=${encodeURIComponent(SETUP_CODE!)}`, {
      headers: { "content-type": "application/json", origin: new URL(base!).origin },
      data: { code: SETUP_CODE },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("no-store");
  });
});
