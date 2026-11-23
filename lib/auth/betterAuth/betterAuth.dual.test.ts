// Better Auth spike: email + password + TOTP through our ServerIdentityProvider, on plain
// PostgreSQL 16. The schema is created by the owner role; the auth runtime uses the shared lib/db
// pool as polynovea_app, like the rest of the direct path.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { getMigrations } from "better-auth/db/migration";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { closeDb, getDb } from "@/lib/db/index";
import type { DB } from "@/lib/db/generated/database";
import { AUTH_SCHEMA, createPolynoveaAuth, type PolynoveaAuth } from "@/lib/auth/betterAuth/server";
import { getBetterAuthServerIdentityProvider } from "@/lib/auth/betterAuth/provider";

const BASE_URL = "http://localhost:3000";
const secret = randomBytes(32).toString("hex");
const password = "correct horse battery staple 42";

let auth: PolynoveaAuth;
let owner: pg.Pool;

/** The signed session cookie value from a Better Auth response. */
function sessionCookie(response: Response, name: string): string | null {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(";")[0]);
}

/** A request carrying the session cookie, as the browser would send it. */
function requestWithSession(cookieName: string, token: string): Request {
  return new Request(`${BASE_URL}/api/admin/me`, { headers: { cookie: `${cookieName}=${encodeURIComponent(token)}` } });
}

async function verifiedUser(identity: ReturnType<typeof getBetterAuthServerIdentityProvider>, cookieName: string, token: string) {
  return (await identity.verifyRequest(requestWithSession(cookieName, token))).identity?.user ?? null;
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: process.env.POLYNOVEA_TEST_POSTGRES_OWNER_URL, ssl: false, max: 2 });
  await owner.query(`create schema if not exists ${AUTH_SCHEMA}`);
  // Migrations run as the owner (DDL); the runtime gets rows only.
  const ownerDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: owner }) });
  // Better Auth's migrator only introspects schema public, so with polynovea_auth it would try to
  // create the tables again on every run. Phase 1 ships this schema as a numbered SQL migration instead.
  const { rows: [existing] } = await owner.query("select to_regclass($1) as t", [`${AUTH_SCHEMA}."user"`]);
  if (!existing.t) {
    const { runMigrations } = await getMigrations(createPolynoveaAuth({ db: ownerDb, secret, baseURL: BASE_URL }).options);
    await runMigrations();
  }
  await owner.query(`
    grant usage on schema ${AUTH_SCHEMA} to polynovea_app;
    grant select, insert, update, delete on all tables in schema ${AUTH_SCHEMA} to polynovea_app;
  `);
  auth = createPolynoveaAuth({ db: getDb(), secret, baseURL: BASE_URL });
});

afterAll(async () => {
  await closeDb();
  await owner.end();
});

describe("Better Auth behind ServerIdentityProvider [postgres]", () => {
  it("creates users in polynovea_auth with UUID ids and Argon2id hashes, as the app role", async () => {
    const identity = getBetterAuthServerIdentityProvider(auth);
    const email = `ba-${randomBytes(4).toString("hex")}@example.test`;
    const { user, error } = await identity.createUser({ email, password, emailConfirmed: true, metadata: { display_name: "Spike" } });
    expect(error).toBeNull();
    expect(user?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(user).toMatchObject({ email, metadata: { display_name: "Spike" } });
    expect(user?.emailConfirmedAt).not.toBeNull();

    const { rows } = await owner.query(`select a.password from ${AUTH_SCHEMA}.account a where a."userId" = $1`, [user!.id]);
    expect(rows[0].password).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

    const { rows: tables } = await owner.query(
      "select table_schema, table_name from information_schema.tables where table_name in ('user', 'session', 'account', 'verification', 'twoFactor') order by 1, 2",
    );
    expect(tables.map((t) => t.table_schema)).toEqual(Array(5).fill(AUTH_SCHEMA));

    const tooShort = await identity.createUser({ email: `short-${email}`, password: "short password", emailConfirmed: true });
    expect(tooShort.error?.message).toMatch(/15 to 128/);
  });

  it("refuses public sign-up; accounts come only from the wizard and admins", async () => {
    const response = await auth.api.signUpEmail({
      body: { email: `self-${randomBytes(4).toString("hex")}@example.test`, password, name: "Self" },
      asResponse: true,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("signs in with email and password, verifies the session through the provider, and rejects it once revoked", async () => {
    const identity = getBetterAuthServerIdentityProvider(auth);
    const email = `ba-${randomBytes(4).toString("hex")}@example.test`;
    const { user } = await identity.createUser({ email, password, emailConfirmed: true });
    const cookieName = (await auth.$context).authCookies.sessionToken.name;

    const wrong = await auth.api.signInEmail({ body: { email, password: "wrong password, long enough" }, asResponse: true });
    expect(wrong.status).toBe(401);

    const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(signedIn.status).toBe(200);
    const token = sessionCookie(signedIn, cookieName);
    expect(token).toBeTruthy();

    const verified = await identity.verifyRequest(requestWithSession(cookieName, token!));
    expect(verified.identity?.user.id).toBe(user!.id);
    expect(verified.identity?.transport).toBe("cookie");
    expect(verified.identity?.sessionId).toBeTruthy();
    expect(Date.now() - verified.identity!.authenticatedAt!.getTime()).toBeLessThan(60_000);
    expect(await verifiedUser(identity, cookieName, "forged.token")).toBeNull();
    // A bearer header is not a credential for the built-in provider.
    expect((await identity.verifyRequest(new Request(BASE_URL, { headers: { authorization: `Bearer ${token}` } }))).identity).toBeNull();

    // Plan regression test: a revoked session is rejected on the next request.
    await auth.api.signOut({ headers: new Headers({ cookie: cookieHeader(signedIn) }) });
    expect(await verifiedUser(identity, cookieName, token!)).toBeNull();
  });

  it("enrols TOTP and then requires the code at sign-in", async () => {
    const identity = getBetterAuthServerIdentityProvider(auth);
    const email = `ba-${randomBytes(4).toString("hex")}@example.test`;
    await identity.createUser({ email, password, emailConfirmed: true });
    const cookieName = (await auth.$context).authCookies.sessionToken.name;

    const first = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const headers = new Headers({ cookie: cookieHeader(first) });
    const enabled = await auth.api.enableTwoFactor({ body: { password }, headers });
    if (enabled.method !== "totp") throw new Error("Expected TOTP enrolment");
    expect(enabled.backupCodes).toHaveLength(10);
    const totpSecret = new URL(enabled.totpURI).searchParams.get("secret")!;
    const code = () => createOTP(base32.decode(totpSecret)).totp();
    const confirmed = await auth.api.verifyTOTP({ body: { code: await code() }, headers, asResponse: true });
    expect(confirmed.status).toBe(200);

    // Password alone no longer yields a session.
    const second = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(second.status).toBe(200);
    expect(await second.clone().json()).toMatchObject({ twoFactorRedirect: true });
    expect(sessionCookie(second, cookieName)).toBeFalsy();

    const wrongCode = await auth.api.verifyTOTP({ body: { code: "000000" }, headers: new Headers({ cookie: cookieHeader(second) }), asResponse: true });
    expect(wrongCode.status).toBe(401);

    const done = await auth.api.verifyTOTP({ body: { code: await code() }, headers: new Headers({ cookie: cookieHeader(second) }), asResponse: true });
    expect(done.status).toBe(200);
    const token = sessionCookie(done, cookieName);
    expect((await verifiedUser(identity, cookieName, token!))?.email).toBe(email);
  });

  it("a password change signs the user out everywhere", async () => {
    const identity = getBetterAuthServerIdentityProvider(auth);
    const email = `ba-${randomBytes(4).toString("hex")}@example.test`;
    const { user } = await identity.createUser({ email, password, emailConfirmed: true });
    const cookieName = (await auth.$context).authCookies.sessionToken.name;
    const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    const token = sessionCookie(signedIn, cookieName)!;
    expect((await identity.updateUser(user!.id, { password: "a brand new long passphrase" })).error).toBeNull();
    expect(await verifiedUser(identity, cookieName, token)).toBeNull();
    const again = await auth.api.signInEmail({ body: { email, password: "a brand new long passphrase" }, asResponse: true });
    expect(again.status).toBe(200);
  });
});
