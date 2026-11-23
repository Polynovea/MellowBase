import { expect, test } from "@playwright/test";

/**
 * Acceptance test 2 (implementation plan, Phase 2): five wrong setup codes lock setup; the correct
 * code still works once the lock is over.
 *
 * Needs a server in setup mode (no database configuration, no installation row) started with a known
 * code: POLYNOVEA_SETUP_CODE=<26 base32 characters>, and the same value in E2E_SETUP_CODE for this
 * test. The browser reaches it on http://127.0.0.1, which the wizard accepts as loopback (the SSH
 * tunnel route). The lock lasts the real 15 minutes; there is deliberately no test-only shortcut in
 * the server, so this test waits it out.
 */

const SETUP_CODE = process.env.E2E_SETUP_CODE;
const LOCK_MINUTES = 15;

test.describe("setup code", () => {
  test.skip(!SETUP_CODE, "E2E_SETUP_CODE is not set (start the server in setup mode with POLYNOVEA_SETUP_CODE to the same value)");

  test("five wrong codes lock setup; the right code works after the lock", async ({ page }) => {
    test.setTimeout((LOCK_MINUTES + 5) * 60_000);

    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Enter the setup code" })).toBeVisible();
    const input = page.getByLabel("Setup code");
    const submit = page.getByRole("button", { name: /continue/i });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await input.fill(`WRONG-${attempt}0000-00000-00000-00000`);
      await submit.click();
      await expect(page.getByRole("alert")).toContainText("That code didn't work");
    }
    await input.fill("WRONG-50000-00000-00000-00000");
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("Too many wrong codes");

    // Locked: even the right code is refused, and no setup cookie is set.
    await input.fill(SETUP_CODE!);
    await submit.click();
    await expect(page.getByRole("alert")).toContainText("Too many wrong codes");
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
      headers: { "content-type": "application/json", origin: new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3100").origin },
      data: { code: SETUP_CODE },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("no-store");
  });
});
