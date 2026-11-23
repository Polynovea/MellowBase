// Contract between the setup wizard and the built-in auth: an owner created by finalise signs in
// through the real Better Auth handler (the app's own instance and configuration), with every
// method the sign-in page offers, and passes the owner's MFA gate.
import { randomBytes, randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closeDb } from "@/lib/db/index";
import { getBuiltinAuth, resetBuiltinAuthForTests } from "@/lib/auth/betterAuth/instance";
import { COOKIE_PREFIX } from "@/lib/auth/betterAuth/server";
import { requireAdminRequest } from "@/lib/admin/serverAccess";
import { resetSetupSessionsForTests } from "@/lib/setup/setupSession";
import { commitOwnerSetup, type FinalisedOwner } from "@/lib/setup/owner/finalise";
import { enrolOwner, TEST_PUBLIC_URL, testWorkspace, withInstallationLock, type EnrolledOwner } from "@/lib/setup/owner/testing";

const savedEnv = { ...process.env };
let owner: pg.Pool;
let app: pg.Pool;
let enrolled: EnrolledOwner;
let created: FinalisedOwner;

/**
 * A tiny browser on the app's own auth handler: keeps cookies and sends the CMS origin. Each one has
 * its own client address, as real browsers do; without one, every test file's sign-ins would share
 * the per-IP sign-in limit (10 a minute) in a full test run.
 */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly address = `100.${64 + randomInt(64)}.${randomInt(256)}.${1 + randomInt(254)}`;

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const response = await getBuiltinAuth().handler(new Request(`${TEST_PUBLIC_URL}/api/auth${path}`, {
      method,
      headers: {
        origin: TEST_PUBLIC_URL,
        "x-forwarded-for": this.address,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = setCookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || attributes.some((a) => /max-age=0\b/i.test(a.trim()))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  hasSession(): boolean {
    return this.cookies.has(`${COOKIE_PREFIX}.session_token`);
  }

  request(path = "/api/admin/users"): Request {
    return new Request(`${TEST_PUBLIC_URL}${path}`, { headers: { cookie: this.cookieHeader() } });
  }
}

/** The signed-in owner passes the full admin gate, MFA requirement included. */
async function expectOwnerSession(browser: Browser) {
  expect(browser.hasSession()).toBe(true);
  const gate = await requireAdminRequest(browser.request());
  expect(gate.error).toBeUndefined();
  expect(gate.data?.user.id).toBe(created.authUserId);
  expect(gate.data?.profile).toMatchObject({ role: "master", is_active: true, email: enrolled.email });
}

async function passwordStep(): Promise<Browser> {
  const browser = new Browser();
  const response = await browser.call("POST", "/sign-in/email", { email: enrolled.email, password: enrolled.password });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
  // The password alone never gives a session.
  expect(browser.hasSession()).toBe(false);
  return browser;
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false, max: 2 });
  app = new pg.Pool({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_URL, ssl: false, max: 2 });
  Object.assign(process.env, {
    AUTH_PROVIDER: "builtin",
    POLYNOVEA_AUTH_SECRET: randomBytes(32).toString("hex"),
    POLYNOVEA_PUBLIC_URL: TEST_PUBLIC_URL,
    POLYNOVEA_HIBP_DISABLED: "true",
    CMS_MASTER_KEY: `k1:${randomBytes(32).toString("base64")}`,
  });
  resetBuiltinAuthForTests();
  await withInstallationLock(owner, async () => {
    const slug = await testWorkspace(owner);
    enrolled = await enrolOwner(process.env, { workspaceSlug: slug });
    created = await commitOwnerSetup(enrolled.ready, { pool: app, env: process.env });
  });
});

afterAll(async () => {
  process.env = { ...savedEnv };
  resetBuiltinAuthForTests();
  resetSetupSessionsForTests();
  await Promise.all([owner.end(), app.end()]);
  await closeDb();
});

describe("an owner created by setup signs in through the real auth handler [postgres]", () => {
  it("with password and the authenticator-app code", async () => {
    const browser = await passwordStep();
    expect((await browser.call("POST", "/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect((await browser.call("POST", "/two-factor/verify-totp", { code: await enrolled.totpCode() })).status).toBe(200);
    await expectOwnerSession(browser);
  });

  it("with the passkey registered during setup, which the sign-in page offers beside the password", async () => {
    const browser = new Browser();
    const options = await (await browser.call("GET", "/passkey/generate-authenticate-options")).json();
    expect(options.rpId).toBe("cms.example.test");
    expect(options.userVerification).toBe("required");
    const signedIn = await browser.call("POST", "/passkey/verify-authentication", { response: enrolled.authenticator.authenticate(options, TEST_PUBLIC_URL) });
    expect(signedIn.status).toBe(200);
    await expectOwnerSession(browser);

    // And after the password step, the passkey completes the sign-in on the same page.
    const afterPassword = await passwordStep();
    const again = await (await afterPassword.call("GET", "/passkey/generate-authenticate-options")).json();
    expect((await afterPassword.call("POST", "/passkey/verify-authentication", { response: enrolled.authenticator.authenticate(again, TEST_PUBLIC_URL) })).status).toBe(200);
    await expectOwnerSession(afterPassword);
  });

  it("with a recovery code, which then cannot be used again", async () => {
    const [first, second] = enrolled.recoveryCodes;
    const browser = await passwordStep();
    expect((await browser.call("POST", "/two-factor/verify-backup-code", { code: first })).status).toBe(200);
    await expectOwnerSession(browser);

    const reuse = await passwordStep();
    expect((await reuse.call("POST", "/two-factor/verify-backup-code", { code: first })).status).toBe(401);
    expect(reuse.hasSession()).toBe(false);
    const next = await passwordStep();
    expect((await next.call("POST", "/two-factor/verify-backup-code", { code: second })).status).toBe(200);
    await expectOwnerSession(next);
  });
});
