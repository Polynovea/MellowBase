import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";

// Phase 2 acceptance tests 1, 3 and 4 for the wizard's owner step, in a real browser with a virtual
// passkey authenticator (Chromium's WebAuthn emulation, user verification on). They need a server in
// setup mode whose database step is done (configured and migrated, no installation row), reached
// on a localhost address: passkeys refuse IP addresses, so 127.0.0.1 will not do. The server runs the
// built-in auth (AUTH_PROVIDER=builtin, built with NEXT_PUBLIC_AUTH_PROVIDER=builtin), so it also needs
// POLYNOVEA_AUTH_SECRET and POLYNOVEA_TRUSTED_PROXIES. Run with playwright.setup.config.ts.
//
//   E2E_SETUP_BASE_URL     e.g. http://localhost:3200; the server's POLYNOVEA_PUBLIC_URL must be the same
//   E2E_SETUP_CODE         its setup code (POLYNOVEA_SETUP_CODE on that server)
//   E2E_OWNER_SCENARIO     "single" (default: acceptance test 1) or "race" (acceptance test 3). Each
//                          finishes setup, so each needs a fresh server.
// Optional:
//   E2E_SERVER_LOG         file capturing that server's output. The setup code works once; acceptance
//                          test 3 reads the replacement code the server prints there for the second
//                          browser (without it, test 3 is skipped)
//   E2E_DATABASE_URL       an owner-role connection to that server's database: counts owners and
//                          installation rows directly (acceptance test 3)
//   E2E_RESTART_COMMAND    a shell command that restarts the server (acceptance test 4 checks /setup
//                          stays closed afterwards); without it that half is skipped and says so
//
// Acceptance test 1 asks for every database option: run this file once per server set up with the
// database step's "on this server", "existing managed database" and "created for you" routes.

const base = process.env.E2E_SETUP_BASE_URL;
const code = process.env.E2E_SETUP_CODE;
const scenario = process.env.E2E_OWNER_SCENARIO === "race" ? "race" : "single";
test.skip(!base || !code, "Set E2E_SETUP_BASE_URL and E2E_SETUP_CODE to run the setup-mode owner tests");
test.use({ baseURL: base });
test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const owner = { email: `owner-${suffix}@example.test`, name: "E2E Owner", password: `an e2e owner passphrase ${suffix}` };

async function withPasskeyDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** The newest replacement code the server printed after a successful use (the code works once). */
async function replacementCode(): Promise<string> {
  const log = process.env.E2E_SERVER_LOG!;
  let found: string | undefined;
  await expect.poll(() => {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    found = [...text.matchAll(/use this new code: ([0-9A-Z-]+)/g)].pop()?.[1];
    return found;
  }, { timeout: 10_000 }).toBeTruthy();
  return found!;
}

async function enterSetupCode(page: Page, setupCode: string = code!): Promise<void> {
  await page.goto("/setup");
  await page.getByLabel("Setup code").fill(setupCode);
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByRole("status")).toContainText("Code accepted");
  await page.goto("/setup/owner");
}

/** Walks every owner sub-step up to (not including) Finish. Returns the TOTP key and the recovery codes. */
async function completeOwnerSteps(page: Page): Promise<{ totpKey: string; recoveryCodes: string[] }> {
  await expect(page.getByRole("heading", { name: "Your owner account" })).toBeVisible();
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Your name").fill(owner.name);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByLabel("Password again").fill(owner.password);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Show the QR code" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  // By its test id: the setup pages show other code boxes too (the CMS's address, the SSH command).
  const totpKey = (await page.getByTestId("totp-manual-key").textContent())!.trim();
  await page.getByLabel("Code from the app").fill(await totpNow(totpKey));
  await page.getByRole("button", { name: "Check the code" }).click();

  await expect(page.getByRole("heading", { name: "Add a passkey" })).toBeVisible();
  if (new URL(base!).hostname === "localhost") await expect(page.getByRole("note")).toContainText("Your passkey only works on this address.");
  await page.getByRole("button", { name: "Add a passkey" }).click();

  await page.getByRole("button", { name: "Show my recovery codes" }).click();
  // Waits for the list itself (reading at once raced the page drawing it), found by its test id.
  await expect(page.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
  const items = await page.getByTestId("recovery-codes").locator("li").allTextContents();
  const recoveryCodes = items.map((text) => text.replace(/^\s*\d+\.\s*/, "").trim()).filter((text) => /^[A-Za-z0-9]{5}-[A-Za-z0-9]{7}$/.test(text));
  expect(recoveryCodes).toHaveLength(10);
  const label = await page.getByLabel(/Type code number \d+/).getAttribute("id");
  const number = Number((await page.locator(`label[for="${label}"]`).textContent())!.match(/number (\d+)/)![1]);
  await page.getByLabel(/Type code number/).fill(recoveryCodes[number - 1]);
  await page.getByRole("button", { name: "Confirm" }).click();

  await page.getByLabel("Organisation name").fill("E2E Organisation");
  await page.getByLabel("Workspace name").fill("E2E Workspace");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Show my keys" }).click();
  for (const [field, testId] of [["Last 6 characters of the master key", "master-key"], ["Last 6 characters of the backup password", "backup-password"]] as const) {
    if (await page.getByLabel(field).count()) {
      const value = (await page.getByTestId(testId).textContent())!.trim();
      await page.getByLabel(field).fill(value.slice(-6));
    }
  }
  await page.getByRole("button", { name: /I've saved them|Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Finish setup" })).toBeVisible();
  return { totpKey, recoveryCodes };
}

async function totpNow(key: string): Promise<string> {
  return createOTP(base32.decode(key), { digits: 6, period: 30 }).totp();
}

async function signInAsOwner(page: Page, totpKey: string): Promise<void> {
  await page.goto("/admin");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  // Exactly "Sign in": the page also has "Sign in with a passkey".
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.getByLabel("Code from your authenticator app").fill(await totpNow(totpKey));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: /CMS WORKSPACE/i })).toBeVisible();
}

async function newBrowser(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await withPasskeyDevice(page);
  return { context, page };
}

test("acceptance 1: a fresh install reaches a signed-in owner using only the browser", async ({ browser }) => {
  test.skip(scenario !== "single", "E2E_OWNER_SCENARIO=race runs acceptance test 3 instead");
  const { context, page } = await newBrowser(browser);
  await enterSetupCode(page);
  const { totpKey } = await completeOwnerSteps(page);
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL("**/admin");
  // The setup cookie is gone; the owner signs in like everyone else, with the second factor.
  expect((await context.cookies()).some((cookie) => cookie.name === "__Host-polynovea-setup")).toBe(false);
  await signInAsOwner(page, totpKey);
  await context.close();
});

test("acceptance 3: two browsers finishing setup at once leave exactly one owner", async ({ browser }) => {
  test.skip(scenario !== "race", "Set E2E_OWNER_SCENARIO=race (on a fresh server) to run acceptance test 3");
  test.skip(!process.env.E2E_SERVER_LOG, "Set E2E_SERVER_LOG: the second browser needs the replacement setup code from the server log");
  const first = await newBrowser(browser);
  await enterSetupCode(first.page);
  const { totpKey } = await completeOwnerSteps(first.page);

  // A second browser enters the replacement code: it takes over the session and carries the progress on.
  const second = await newBrowser(browser);
  await enterSetupCode(second.page, await replacementCode());
  await expect(second.page.getByRole("heading", { name: "Finish setup" })).toBeVisible();

  // Both press Finish at the same moment.
  const finish = (page: Page) => page.evaluate(async () => {
    const response = await fetch("/api/setup/owner/finish", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}" });
    return { status: response.status, body: await response.json() };
  });
  const results = await Promise.all([finish(first.page), finish(second.page)]);
  expect(results.filter((result) => result.status === 200)).toHaveLength(1);
  const refused = results.find((result) => result.status !== 200)!;
  expect([401, 404, 409]).toContain(refused.status);
  if (refused.status === 409) expect(refused.body.error).toBe("Setup was finished in another browser. Sign in with the owner account.");

  if (process.env.E2E_DATABASE_URL) {
    const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await db.connect();
    try {
      const { rows: [counts] } = await db.query(
        `select (select count(*)::int from public.installation) as installations,
                (select count(*)::int from admin_users where role = 'master' and is_active) as owners,
                (select count(*)::int from polynovea_auth."user" where email = $1) as users`,
        [owner.email],
      );
      expect(counts).toEqual({ installations: 1, owners: 1, users: 1 });
    } finally {
      await db.end();
    }
  }
  await signInAsOwner(second.page, totpKey);
  await Promise.all([first.context.close(), second.context.close()]);
});

test("acceptance 4: after setup, /setup is 404, and a restart does not reopen it", async ({ request }) => {
  const closed = async () => {
    expect((await request.get("/setup")).status()).toBe(404);
    expect((await request.get("/setup/owner")).status()).toBe(404);
    expect((await request.get("/api/setup/owner")).status()).toBe(404);
    const post = await request.post("/api/setup/code", { headers: { origin: new URL(base!).origin, "content-type": "application/json" }, data: { code } });
    expect(post.status()).toBe(404);
  };
  await closed();

  const restart = process.env.E2E_RESTART_COMMAND;
  test.info().annotations.push({ type: "restart", description: restart ? "restarted with E2E_RESTART_COMMAND" : "not restarted: set E2E_RESTART_COMMAND to check this half" });
  if (!restart) return;
  execSync(restart, { stdio: "inherit", timeout: 180_000 });
  await expect.poll(async () => (await request.get("/api/health").catch(() => null))?.status() ?? 0, { timeout: 120_000 }).toBe(200);
  await closed();
});
