// Built-in auth (Better Auth) on plain PostgreSQL 16, as the polynovea_app role, with the schema from
// migration 0071. Better Auth only exists on the direct path, so these run against the postgres
// backend; the Supabase side keeps GoTrue (see lib/auth/authMigrate.dual.test.ts for the move).
//
// Includes the plan's regression tests for the bug classes Better Auth has had: a revoked session is
// rejected on the next request; an unverified OAuth email never links; parallel wrong TOTP and
// recovery-code attempts cannot exceed the limit; rate limits hold behind a proxy and across an IPv6
// /64; a passkey from the wrong origin is refused.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import bcrypt from "bcryptjs";
import { getMigrations } from "better-auth/db/migration";
import { createAuthEndpoint } from "better-auth/api";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { closeDb, getDb } from "@/lib/db/index";
import { AUTH_SCHEMA, COOKIE_PREFIX, createPolynoveaAuth, type PolynoveaAuthSettings } from "@/lib/auth/betterAuth/server";
import { getBetterAuthServerIdentityProvider } from "@/lib/auth/betterAuth/provider";
import { provisionManagedIdentity } from "@/lib/admin/managedProvisioning";
import { SoftAuthenticator } from "@/lib/auth/betterAuth/testing/softAuthenticator";

const BASE_URL = "https://cms.example.test";
const secret = randomBytes(32).toString("hex");
const password = "correct horse battery staple 42";
const noPwned = async () => null;

let owner: pg.Pool;

function makeAuth(extra: Partial<PolynoveaAuthSettings> = {}) {
  return createPolynoveaAuth({ db: getDb(), secret, baseURL: BASE_URL, rateLimit: false, pwnedLookup: noPwned, ...extra });
}
type Auth = ReturnType<typeof makeAuth>;

/** A tiny browser: keeps cookies between calls and sends the CMS origin, as the admin UI would. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly auth: Auth, private readonly headers: Record<string, string> = {}) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const response = await this.auth.handler(new Request(`${BASE_URL}/api/auth${path}`, {
      method,
      headers: {
        origin: BASE_URL,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...this.headers,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = setCookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => /max-age=0\b/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  request(path = "/api/admin/me"): Request {
    return new Request(`${BASE_URL}${path}`, { headers: { cookie: this.cookieHeader() } });
  }
}

async function newUser(auth: Auth, overrides: { password?: string } = {}) {
  const identity = getBetterAuthServerIdentityProvider(auth, { pwnedLookup: noPwned });
  const email = `ba-${randomBytes(5).toString("hex")}@example.test`;
  const { user, error } = await identity.createUser({ email, password: overrides.password ?? password, emailConfirmed: true });
  if (error || !user) throw error ?? new Error("no user");
  return { identity, email, user };
}

async function signIn(auth: Auth, email: string, pass = password, headers: Record<string, string> = {}) {
  const browser = new Browser(auth, headers);
  const response = await browser.call("POST", "/sign-in/email", { email, password: pass });
  return { browser, response };
}

async function enrolTotp(auth: Auth, email: string) {
  const { browser } = await signIn(auth, email);
  const enabled = await browser.call("POST", "/two-factor/enable", { password });
  const body = await enabled.json();
  const totpSecret = new URL(body.totpURI).searchParams.get("secret")!;
  const code = () => createOTP(base32.decode(totpSecret)).totp();
  expect((await browser.call("POST", "/two-factor/verify-totp", { code: await code() })).status).toBe(200);
  return { code, backupCodes: body.backupCodes as string[] };
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false, max: 2 });
});

afterAll(async () => {
  await closeDb();
  await owner.end();
});

describe("built-in auth schema [postgres]", () => {
  it("migration 0071 creates exactly what Better Auth and its plugins expect", async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(makeAuth().options);
    expect(toBeCreated.map((t) => t.table)).toEqual([]);
    expect(toBeAdded.map((t) => `${t.table}: ${Object.keys(t.fields).join(", ")}`)).toEqual([]);
  });

  it("the app role can use the tables but not change them", async () => {
    const app = new pg.Client({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_URL, ssl: false });
    await app.connect();
    try {
      await expect(app.query(`select count(*) from ${AUTH_SCHEMA}."session"`)).resolves.toBeTruthy();
      await expect(app.query(`alter table ${AUTH_SCHEMA}."session" add column x int`)).rejects.toThrow();
      await expect(app.query(`create table ${AUTH_SCHEMA}.x (id int)`)).rejects.toThrow();
    } finally {
      await app.end();
    }
  });
});

describe("built-in auth: accounts and passwords [postgres]", () => {
  it("creates users with UUID ids and Argon2id hashes", async () => {
    const { user } = await newUser(makeAuth());
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const { rows } = await owner.query(`select password from ${AUTH_SCHEMA}.account where "userId" = $1`, [user.id]);
    expect(rows[0].password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it("applies the password rules: 15 characters without MFA, the bundled list, and the breach API", async () => {
    const auth = makeAuth();
    const identity = getBetterAuthServerIdentityProvider(auth, { pwnedLookup: noPwned });
    const email = () => `pw-${randomBytes(4).toString("hex")}@example.test`;
    expect((await identity.createUser({ email: email(), password: "fourteen chars", emailConfirmed: true })).error?.message).toMatch(/at least 15/);
    expect((await identity.createUser({ email: email(), password: "password12345678", emailConfirmed: true })).error?.message).toMatch(/too common/);
    expect((await identity.createUser({ email: email(), password: "ü".repeat(15), emailConfirmed: true })).error?.message).toMatch(/too common/);
    // A password the range API reports as breached; only the hash prefix is sent.
    const prefixes: string[] = [];
    const breached = getBetterAuthServerIdentityProvider(auth, {
      pwnedLookup: async (prefix) => {
        prefixes.push(prefix);
        const { createHash } = await import("node:crypto");
        return `${createHash("sha1").update("an otherwise fine passphrase").digest("hex").toUpperCase().slice(5)}:12\r\nABCDEF:0`;
      },
    });
    expect((await breached.createUser({ email: email(), password: "an otherwise fine passphrase", emailConfirmed: true })).error?.message).toMatch(/breach/);
    expect(prefixes).toEqual([expect.stringMatching(/^[0-9A-F]{5}$/)]);
    // Long Unicode passphrases are fine.
    expect((await identity.createUser({ email: email(), password: "ein sehr langer Satz mit Ümlauten und 🙂 darin", emailConfirmed: true })).error).toBeNull();
  });

  it("refuses public sign-up; accounts come only from the wizard and admins", async () => {
    const response = await makeAuth().api.signUpEmail({ body: { email: `self-${randomBytes(4).toString("hex")}@example.test`, password, name: "Self" }, asResponse: true });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("verifies a GoTrue bcrypt hash and replaces it with Argon2id at the next sign-in", async () => {
    const auth = makeAuth();
    const { user, email } = await newUser(auth);
    const legacy = "a legacy gotrue password";
    await owner.query(`update ${AUTH_SCHEMA}.account set password = $2 where "userId" = $1`, [user.id, await bcrypt.hash(legacy, 10)]);
    expect((await signIn(auth, email, "the wrong legacy password")).response.status).toBe(401);
    expect((await signIn(auth, email, legacy)).response.status).toBe(200);
    const { rows } = await owner.query(`select password from ${AUTH_SCHEMA}.account where "userId" = $1`, [user.id]);
    expect(rows[0].password).toMatch(/^\$argon2id\$/);
    expect((await signIn(auth, email, legacy)).response.status).toBe(200);
  });

  it("change-password enforces the same rules through the library's own endpoint", async () => {
    const auth = makeAuth();
    const { email } = await newUser(auth);
    const { browser } = await signIn(auth, email);
    const short = await browser.call("POST", "/change-password", { currentPassword: password, newPassword: "only 12 char" });
    expect(short.status).toBe(400);
    expect((await short.json()).message).toMatch(/at least 15/);
    expect((await browser.call("POST", "/change-password", { currentPassword: password, newPassword: "another long passphrase 7" })).status).toBe(200);
  });
});

describe("built-in auth: sessions [postgres]", () => {
  it("issues a __Host- cookie (HttpOnly, Secure, SameSite=Lax, Path=/) and never a cookie cache", async () => {
    const auth = makeAuth();
    const { email } = await newUser(auth);
    const { response } = await signIn(auth, email);
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${COOKIE_PREFIX}.session_token=`));
    expect(session).toBeTruthy();
    expect(session).toMatch(/; HttpOnly/i);
    expect(session).toMatch(/; Secure/i);
    expect(session).toMatch(/; SameSite=Lax/i);
    expect(session).toMatch(/; Path=\//i);
    expect(session).not.toMatch(/Domain=/i);
    expect(cookies.some((c) => c.includes("session_data"))).toBe(false);
  });

  it("regression: a revoked session is rejected on the next request", async () => {
    const auth = makeAuth();
    const { identity, email, user } = await newUser(auth);
    const { browser } = await signIn(auth, email);
    const verified = await identity.verifyRequest(browser.request());
    expect(verified.identity?.user.id).toBe(user.id);
    expect(verified.identity?.transport).toBe("cookie");
    expect(Date.now() - verified.identity!.authenticatedAt!.getTime()).toBeLessThan(60_000);

    // Revoked through the API, through sign out everywhere, and straight in the table.
    const sessions = await (await browser.call("GET", "/list-sessions")).json();
    expect(sessions).toHaveLength(1);
    expect((await identity.revokeUserSessions(user.id)).error).toBeNull();
    expect((await identity.verifyRequest(browser.request())).identity).toBeNull();

    const second = await signIn(auth, email);
    expect((await identity.verifyRequest(second.browser.request())).identity).not.toBeNull();
    await owner.query(`delete from ${AUTH_SCHEMA}."session" where "userId" = $1`, [user.id]);
    expect((await identity.verifyRequest(second.browser.request())).identity).toBeNull();
  });

  it("a forged cookie or a bearer header is not a credential", async () => {
    const auth = makeAuth();
    const identity = getBetterAuthServerIdentityProvider(auth);
    const forged = new Request(BASE_URL, { headers: { cookie: `${COOKIE_PREFIX}.session_token=forged.token` } });
    expect((await identity.verifyRequest(forged)).identity).toBeNull();
    const { email } = await newUser(auth);
    const { browser } = await signIn(auth, email);
    const token = browser.cookies.get(`${COOKIE_PREFIX}.session_token`)!;
    expect((await identity.verifyRequest(new Request(BASE_URL, { headers: { authorization: `Bearer ${token}` } }))).identity).toBeNull();
  });

  it("signing in again from the same browser ends its previous session (new session ID on login)", async () => {
    const auth = makeAuth();
    const { identity, email, user } = await newUser(auth);
    const { browser } = await signIn(auth, email);
    const before = (await identity.verifyRequest(browser.request())).identity!.sessionId;
    const oldCookie = browser.cookieHeader();
    expect((await browser.call("POST", "/sign-in/email", { email, password })).status).toBe(200);
    const after = (await identity.verifyRequest(browser.request())).identity!.sessionId;
    expect(after).not.toBe(before);
    expect((await identity.verifyRequest(new Request(BASE_URL, { headers: { cookie: oldCookie } }))).identity).toBeNull();
    const { rows } = await owner.query(`select count(*)::int as n from ${AUTH_SCHEMA}."session" where "userId" = $1`, [user.id]);
    expect(rows[0].n).toBe(1);
  });

  it("idle timeout is 12 hours, and refreshes never take a session past 7 days from sign-in", async () => {
    const auth = makeAuth();
    const { identity, email, user } = await newUser(auth);
    const { browser } = await signIn(auth, email);
    const { rows: [fresh] } = await owner.query(`select extract(epoch from ("expiresAt" - "createdAt")) as seconds from ${AUTH_SCHEMA}."session" where "userId" = $1`, [user.id]);
    expect(Math.abs(Number(fresh.seconds) - 12 * 3600)).toBeLessThan(5);

    // Six days and 23 hours in, with the idle window due for a refresh.
    await owner.query(
      `update ${AUTH_SCHEMA}."session" set "createdAt" = now() - interval '6 days 23 hours', "updatedAt" = now() - interval '1 hour', "expiresAt" = now() + interval '30 minutes' where "userId" = $1`,
      [user.id],
    );
    expect((await browser.call("GET", "/get-session")).status).toBe(200);
    const { rows: [capped] } = await owner.query(`select extract(epoch from ("expiresAt" - "createdAt")) as seconds from ${AUTH_SCHEMA}."session" where "userId" = $1`, [user.id]);
    expect(Number(capped.seconds)).toBeLessThanOrEqual(7 * 24 * 3600 + 1);

    // Past 7 days the session is refused even if its expiry were later.
    await owner.query(`update ${AUTH_SCHEMA}."session" set "createdAt" = now() - interval '7 days 1 minute', "expiresAt" = now() + interval '1 hour' where "userId" = $1`, [user.id]);
    expect((await identity.verifyRequest(browser.request())).identity).toBeNull();
  });
});

describe("built-in auth: second factors [postgres]", () => {
  it("enrols TOTP with 10 recovery codes and then requires the code at sign-in", async () => {
    const auth = makeAuth();
    const { identity, email } = await newUser(auth);
    const { code, backupCodes } = await enrolTotp(auth, email);
    expect(backupCodes).toHaveLength(10);

    const second = await signIn(auth, email);
    expect(await second.response.clone().json()).toMatchObject({ twoFactorRedirect: true });
    expect(second.browser.cookies.has(`${COOKIE_PREFIX}.session_token`)).toBe(false);
    expect((await second.browser.call("POST", "/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    // Asking to trust the device is ignored: MFA is required at every sign-in.
    expect((await second.browser.call("POST", "/two-factor/verify-totp", { code: await code(), trustDevice: true })).status).toBe(200);
    expect([...second.browser.cookies.keys()].some((name) => name.includes("trust_device"))).toBe(false);
    expect((await identity.verifyRequest(second.browser.request())).identity?.user.email).toBe(email);

    // A recovery code works once.
    const third = await signIn(auth, email);
    expect((await third.browser.call("POST", "/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
    const fourth = await signIn(auth, email);
    expect((await fourth.browser.call("POST", "/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(401);
  });

  it("stores recovery codes encrypted, never in plain text", async () => {
    const auth = makeAuth();
    const { email, user } = await newUser(auth);
    const { backupCodes } = await enrolTotp(auth, email);
    const { rows } = await owner.query(`select "backupCodes" from ${AUTH_SCHEMA}."twoFactor" where "userId" = $1`, [user.id]);
    for (const value of backupCodes) expect(rows[0].backupCodes).not.toContain(value);
  });

  it("regression: parallel wrong TOTP codes cannot exceed the per-challenge limit, and the account pauses after 10", async () => {
    const auth = makeAuth();
    const { email, user } = await newUser(auth);
    const { code } = await enrolTotp(auth, email);

    const { browser } = await signIn(auth, email);
    const results = await Promise.all(Array.from({ length: 25 }, () => browser.call("POST", "/two-factor/verify-totp", { code: "000000" })));
    const bodies = await Promise.all(results.map((r) => r.json().catch(() => ({}))));
    const checked = bodies.filter((b) => b.code === "INVALID_CODE").length;
    expect(results.every((r) => r.status !== 200)).toBe(true);
    expect(checked).toBeLessThanOrEqual(5);
    const { rows: [after] } = await owner.query(`select "failedVerificationCount" as n from ${AUTH_SCHEMA}."twoFactor" where "userId" = $1`, [user.id]);
    expect(after.n).toBe(checked);

    // New challenges, still in parallel: the account-wide count stops at the limit and then locks.
    for (let round = 0; round < 3; round += 1) {
      const next = await signIn(auth, email);
      await Promise.all(Array.from({ length: 10 }, () => next.browser.call("POST", "/two-factor/verify-totp", { code: "000000" })));
    }
    const { rows: [locked] } = await owner.query(`select "failedVerificationCount" as n, "lockedUntil" from ${AUTH_SCHEMA}."twoFactor" where "userId" = $1`, [user.id]);
    expect(locked.n).toBeLessThanOrEqual(15);
    expect(locked.lockedUntil).not.toBeNull();
    const last = await signIn(auth, email);
    expect((await last.browser.call("POST", "/two-factor/verify-totp", { code: await code() })).status).toBe(429);
  });

  it("regression: parallel wrong recovery codes cannot exceed the per-challenge limit", async () => {
    const auth = makeAuth();
    const { email } = await newUser(auth);
    const { backupCodes } = await enrolTotp(auth, email);
    const { browser } = await signIn(auth, email);
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => browser.call("POST", "/two-factor/verify-backup-code", { code: `wrong-${i}` })));
    const bodies = await Promise.all(results.map((r) => r.json().catch(() => ({}))));
    expect(bodies.filter((b) => b.code === "INVALID_BACKUP_CODE").length).toBeLessThanOrEqual(5);
    expect(results.every((r) => r.status !== 200)).toBe(true);
    // That challenge is spent; the right code works only on a fresh one.
    expect((await browser.call("POST", "/two-factor/verify-backup-code", { code: backupCodes[1] })).status).not.toBe(200);
    const fresh = await signIn(auth, email);
    expect((await fresh.browser.call("POST", "/two-factor/verify-backup-code", { code: backupCodes[1] })).status).toBe(200);
  });

  it("8 characters are enough once the account has MFA", async () => {
    const auth = makeAuth();
    const { identity, email, user } = await newUser(auth);
    expect((await identity.updateUser(user.id, { password: "eight ch" })).error?.message).toMatch(/at least 15/);
    await enrolTotp(auth, email);
    expect((await identity.updateUser(user.id, { password: "eight ch" })).error).toBeNull();
  });
});

describe("built-in auth: passkeys [postgres]", () => {
  async function registerPasskey(auth: Auth, email: string, origin = BASE_URL) {
    const { browser } = await signIn(auth, email);
    const options = await (await browser.call("GET", "/passkey/generate-register-options")).json();
    expect(options.rp.id).toBe("cms.example.test");
    expect(options.authenticatorSelection.userVerification).toBe("required");
    const authenticator = new SoftAuthenticator("cms.example.test");
    const response = await browser.call("POST", "/passkey/verify-registration", { response: authenticator.register(options, origin), name: "Test key" });
    return { browser, authenticator, response };
  }

  it("registers a passkey from the CMS origin and signs in with it", async () => {
    const auth = makeAuth();
    const { identity, email, user } = await newUser(auth);
    const { authenticator, response } = await registerPasskey(auth, email);
    expect(response.status).toBe(200);

    const browser = new Browser(auth);
    const options = await (await browser.call("GET", "/passkey/generate-authenticate-options")).json();
    const signedIn = await browser.call("POST", "/passkey/verify-authentication", { response: authenticator.authenticate(options, BASE_URL) });
    expect(signedIn.status).toBe(200);
    expect((await identity.verifyRequest(browser.request())).identity?.user.id).toBe(user.id);
  });

  it("regression: a passkey from the wrong origin is refused, at registration and at sign-in", async () => {
    const auth = makeAuth();
    const { email } = await newUser(auth);
    expect((await registerPasskey(auth, email, "https://cms.example.test.evil.example")).response.status).toBeGreaterThanOrEqual(400);
    expect((await registerPasskey(auth, email, "http://cms.example.test")).response.status).toBeGreaterThanOrEqual(400);

    const { authenticator } = await registerPasskey(auth, email);
    for (const origin of ["https://evil.example", "https://sub.cms.example.test", "http://cms.example.test"]) {
      const browser = new Browser(auth);
      const options = await (await browser.call("GET", "/passkey/generate-authenticate-options")).json();
      const attempt = await browser.call("POST", "/passkey/verify-authentication", { response: authenticator.authenticate(options, origin) });
      expect(attempt.status).toBeGreaterThanOrEqual(400);
      expect(browser.cookies.has(`${COOKIE_PREFIX}.session_token`)).toBe(false);
    }
  });
});

describe("built-in auth: OAuth linking [postgres]", () => {
  // Drives the library's own OAuth user-info handling (used by every social and generic OAuth
  // provider) through a test-only endpoint, so the rule holds before any provider is configured.
  const oauthProbe = {
    id: "oauth-probe",
    endpoints: {
      oauthProbe: createAuthEndpoint("/oauth-probe", { method: "POST" }, async (ctx) => {
        const body = ctx.body as { email: string; emailVerified: boolean; accountId: string };
        const result = await handleOAuthUserInfo(ctx, {
          userInfo: { id: body.accountId, email: body.email, emailVerified: body.emailVerified, name: "OAuth", image: null },
          account: { providerId: "google", accountId: body.accountId },
          disableSignUp: true,
        });
        return ctx.json({ error: result.error, linked: Boolean(result.data) });
      }),
    },
  };

  it("regression: an unverified OAuth email never links to an existing account", async () => {
    const auth = makeAuth({ testPlugins: [oauthProbe] });
    const { email, user } = await newUser(auth);
    const probe = (emailVerified: boolean, accountId: string) =>
      auth.handler(new Request(`${BASE_URL}/api/auth/oauth-probe`, {
        method: "POST",
        headers: { origin: BASE_URL, "content-type": "application/json" },
        body: JSON.stringify({ email: email.toUpperCase(), emailVerified, accountId }),
      })).then((r) => r.json());

    const unverified = await probe(false, "google-unverified");
    expect(unverified.linked).toBe(false);
    expect(unverified.error).toBeTruthy();
    const { rows } = await owner.query(`select "providerId" from ${AUTH_SCHEMA}.account where "userId" = $1`, [user.id]);
    expect(rows.map((r) => r.providerId)).toEqual(["credential"]);
  });
});

describe("built-in auth: rate limits [postgres]", () => {
  const signInAttempts = async (auth: Auth, email: string, count: number, forwardedFor: (i: number) => string) => {
    const statuses: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const { response } = await signIn(auth, email, "wrong password, long enough", { "x-forwarded-for": forwardedFor(i) });
      statuses.push(response.status);
    }
    return statuses;
  };

  it("regression: behind the trusted proxy, a spoofed X-Forwarded-For cannot dodge the per-IP limit", async () => {
    const auth = makeAuth({ rateLimit: true, trustedProxies: ["10.0.0.0/8"] });
    const { email } = await newUser(auth);
    // The client prepends random addresses; the proxy appended the real one, then an internal hop.
    const client = `198.51.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    const statuses = await signInAttempts(auth, email, 14, (i) => `203.0.113.${i}, 198.18.${randomBytes(1)[0]}.${i}, ${client}, 10.1.2.3`);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429, 429, 429]);
    const { rows } = await owner.query(`select key from ${AUTH_SCHEMA}."rateLimit" where key like $1`, [`%${client}%`]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("regression: IPv6 clients are limited per /64, so rotating addresses inside it does not help", async () => {
    const auth = makeAuth({ rateLimit: true, trustedProxies: ["10.0.0.0/8"] });
    const { email } = await newUser(auth);
    const prefix = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}`;
    const statuses = await signInAttempts(auth, email, 12, (i) => `${prefix}::${(i + 1).toString(16)}, 10.1.2.3`);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Another /64 is a different client.
    const other = await signInAttempts(auth, email, 1, () => `2001:db8:ffff:${randomBytes(2).toString("hex")}::1, 10.1.2.3`);
    expect(other).toEqual([401]);
  });

  it("throttles sign-in per account across addresses, without a hard lockout", async () => {
    const auth = makeAuth({ rateLimit: true, trustedProxies: ["10.0.0.0/8"] });
    const { email } = await newUser(auth);
    const net = `192.0.${randomBytes(1)[0]}`;
    const statuses = await signInAttempts(auth, email, 32, (i) => `${net}.${i + 1}, 10.1.2.3`);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    // The window passes and the account works again.
    await owner.query(`update ${AUTH_SCHEMA}."rateLimit" set "lastRequest" = "lastRequest" - 16 * 60 * 1000 where key like 'account:%'`);
    expect((await signIn(auth, email, password, { "x-forwarded-for": `${net}.200, 10.1.2.3` })).response.status).toBe(200);
  });
});

describe("built-in auth: managed provisioning replaces the 0065 trigger [postgres]", () => {
  it("gives a new identity a viewer profile, membership and role when provisioning is on", async () => {
    const suffix = randomBytes(4).toString("hex");
    const { rows: [workspace] } = await owner.query("insert into workspaces (name, slug) values ($1, $2) returning id", [`Prov ${suffix}`, `prov-${suffix}`]);
    const { rows: [role] } = await owner.query(
      "insert into roles (workspace_id, key, name, is_system) values ($1, 'viewer', 'Viewer', true) returning id",
      [workspace.id],
    );
    const { rows: [before] } = await owner.query("select enabled, workspace_slug from cms_auth_provisioning where singleton");
    await owner.query("update cms_auth_provisioning set enabled = true, workspace_slug = $1 where singleton", [`prov-${suffix}`]);
    try {
      const auth = makeAuth({ onUserCreated: async (user) => void (await provisionManagedIdentity(user)) });
      const { user, email } = await newUser(auth);
      const { rows } = await owner.query(
        `select a.role, a.email, a.module_write_access, m.workspace_id, r.role_id
           from admin_users a join workspace_members m on m.admin_user_id = a.id join member_roles r on r.workspace_member_id = m.id
          where a.auth_user_id = $1`,
        [user.id],
      );
      expect(rows).toEqual([{ role: "viewer", email, module_write_access: [], workspace_id: workspace.id, role_id: role.id }]);
    } finally {
      await owner.query("update cms_auth_provisioning set enabled = $1, workspace_slug = $2 where singleton", [before.enabled, before.workspace_slug]);
    }
  });

  it("does nothing while provisioning is off", async () => {
    const auth = makeAuth({ onUserCreated: async (user) => void (await provisionManagedIdentity(user)) });
    const { user } = await newUser(auth);
    const { rows } = await owner.query("select id from admin_users where auth_user_id = $1", [user.id]);
    expect(rows).toEqual([]);
  });
});
