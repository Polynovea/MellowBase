import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { SoftAuthenticator } from "@/lib/auth/betterAuth/testing/softAuthenticator";
import { generateSecret, writeConfig } from "@/lib/setup/configStore";
import { loadKeyRing, resetKeyRingCache } from "@/lib/setup/keyRing";
import { resetSetupSessionsForTests, startSetupSession, type SetupSession } from "@/lib/setup/setupSession";
import {
  confirmKeys,
  confirmRecoveryCode,
  confirmTotp,
  EnrolmentError,
  enrolmentSummary,
  generateRecoveryCodes,
  issueRecoveryCodes,
  passkeyRegistrationOptions,
  publicAddress,
  readEnrolment,
  readyEnrolment,
  revealKeys,
  stageAccount,
  stageOrganisation,
  startTotp,
  TEMPORARY_ROUTE_WARNING,
  usernameFromEmail,
  verifyPasskeyRegistration,
} from "@/lib/setup/owner/enrolment";
import { enrolOwner, noPwned } from "@/lib/setup/owner/testing";

const PUBLIC = "https://cms.example.test";
const password = "a long setup passphrase 42";
let env: Record<string, string | undefined>;
let session: SetupSession;

const code = async (promise: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof promise === "function" ? promise() : promise);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(EnrolmentError);
    return (error as EnrolmentError).code;
  }
};

async function withAccount(email = "Owner@Example.test") {
  await stageAccount(session, { email, displayName: "  The   Owner ", password }, { pwnedLookup: noPwned });
}

beforeEach(() => {
  resetSetupSessionsForTests();
  resetKeyRingCache();
  env = { POLYNOVEA_PUBLIC_URL: PUBLIC, POLYNOVEA_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "polynovea-owner-")), CMS_MASTER_KEY: `k1:${randomBytes(32).toString("base64")}` };
  session = startSetupSession("https").session;
});

afterEach(() => resetKeyRingCache());

describe("account", () => {
  it("checks the password with the single-factor rules, keeps only an Argon2id hash, and normalises the details", async () => {
    expect(await code(stageAccount(session, { email: "owner@example.test", displayName: "Owner", password: "short pass" }, { pwnedLookup: noPwned }))).toBe("PASSWORD_POLICY");
    expect(await code(stageAccount(session, { email: "owner@example.test", displayName: "Owner", password: "password12345678" }, { pwnedLookup: noPwned }))).toBe("PASSWORD_POLICY");
    expect(await code(stageAccount(session, { email: "not an email", displayName: "Owner", password }, { pwnedLookup: noPwned }))).toBe("EMAIL_INVALID");
    expect(readEnrolment(session).account).toBeUndefined();

    await withAccount();
    const { account } = readEnrolment(session);
    expect(account).toMatchObject({ email: "owner@example.test", displayName: "The Owner", username: "owner" });
    expect(account!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(readEnrolment(session))).not.toContain(password);
  });

  it("derives a valid username from any address", () => {
    expect(usernameFromEmail("Jo@example.test")).toBe("jo-owner");
    expect(usernameFromEmail("first.last+cms@example.test")).toBe("first.last-cms");
    expect(usernameFromEmail("a".repeat(60) + "@example.test")).toHaveLength(40);
  });

  it("a different email clears the authenticator app and passkey made for the old one", async () => {
    await withAccount();
    startTotp(session);
    await withAccount("owner@example.test");
    expect(readEnrolment(session).totp).toBeDefined();
    await withAccount("someone.else@example.test");
    expect(readEnrolment(session).totp).toBeUndefined();
  });
});

describe("authenticator app", () => {
  it("uses Better Auth's settings: issuer Polynovea CMS, 6 digits, 30 seconds, the account's email", async () => {
    expect(await code(() => startTotp(session))).toBe("ACCOUNT_FIRST");
    await withAccount();
    const { totpURI } = startTotp(session);
    const url = new URL(totpURI);
    expect(url.protocol).toBe("otpauth:");
    expect(decodeURIComponent(url.pathname)).toContain("Polynovea CMS:owner@example.test");
    expect(url.searchParams.get("issuer")).toBe("Polynovea CMS");
    expect(url.searchParams.get("digits")).toBe("6");
    expect(url.searchParams.get("period")).toBe("30");
    const secret = readEnrolment(session).totp!.secret;
    expect(secret).toHaveLength(32);
    expect(new TextDecoder().decode(base32.decode(url.searchParams.get("secret")!))).toBe(secret);
  });

  it("is confirmed only by a current code", async () => {
    await withAccount();
    startTotp(session);
    expect(await code(confirmTotp(session, "12345"))).toBe("TOTP_FORMAT");
    const secret = readEnrolment(session).totp!.secret;
    const right = await createOTP(secret, { digits: 6, period: 30 }).totp();
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await code(confirmTotp(session, wrong))).toBe("TOTP_WRONG");
    expect(readEnrolment(session).totp!.confirmed).toBe(false);
    await confirmTotp(session, right.slice(0, 3) + " " + right.slice(3));
    expect(readEnrolment(session).totp!.confirmed).toBe(true);
  });
});

describe("passkey", () => {
  it("takes rpID and origin only from POLYNOVEA_PUBLIC_URL and requires user verification", async () => {
    await withAccount();
    const { options, temporary, warning } = await passkeyRegistrationOptions(session, env);
    expect(options.rp).toEqual({ id: "cms.example.test", name: "Polynovea CMS" });
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.attestation).toBe("none");
    expect(options.user.name).toBe("owner@example.test");
    expect(temporary).toBe(false);
    expect(warning).toBeNull();

    const authenticator = new SoftAuthenticator("cms.example.test");
    await verifyPasskeyRegistration(session, authenticator.register(options, PUBLIC), env);
    const credential = readEnrolment(session).passkey!.credential!;
    expect(credential).toMatchObject({ credentialID: authenticator.credentialId.toString("base64url"), counter: 0, rpID: "cms.example.test", backedUp: false });
    expect(Buffer.from(credential.publicKey, "base64").length).toBeGreaterThan(60);
  });

  it("refuses another origin, a reused challenge, and a missing or plain-HTTP public address", async () => {
    await withAccount();
    const authenticator = new SoftAuthenticator("cms.example.test");
    const first = await passkeyRegistrationOptions(session, env);
    expect(await code(verifyPasskeyRegistration(session, authenticator.register(first.options, "https://evil.example.test"), env))).toBe("PASSKEY_REJECTED");
    // The challenge was used up by that attempt.
    expect(await code(verifyPasskeyRegistration(session, authenticator.register(first.options, PUBLIC), env))).toBe("PASSKEY_CHALLENGE");
    expect(readEnrolment(session).passkey?.credential).toBeUndefined();

    expect(await code(passkeyRegistrationOptions(session, {}))).toBe("PUBLIC_URL_MISSING");
    expect(await code(passkeyRegistrationOptions(session, { POLYNOVEA_PUBLIC_URL: "http://cms.example.test" }))).toBe("PUBLIC_URL_INSECURE");
  });

  it("an expired challenge is refused", async () => {
    await withAccount();
    const { options } = await passkeyRegistrationOptions(session, env, 1_000);
    const authenticator = new SoftAuthenticator("cms.example.test");
    expect(await code(verifyPasskeyRegistration(session, authenticator.register(options, PUBLIC), env, 1_000 + 6 * 60_000))).toBe("PASSKEY_CHALLENGE");
  });

  it("on localhost (an SSH tunnel or a trial) warns that the passkey belongs to this address", async () => {
    await withAccount();
    const local = { ...env, POLYNOVEA_PUBLIC_URL: "http://localhost:3000" };
    expect(publicAddress(local)).toEqual({ origin: "http://localhost:3000", rpID: "localhost", temporary: true });
    const { options, temporary, warning } = await passkeyRegistrationOptions(session, local);
    expect(temporary).toBe(true);
    expect(warning).toBe(TEMPORARY_ROUTE_WARNING);
    const authenticator = new SoftAuthenticator("localhost");
    await verifyPasskeyRegistration(session, authenticator.register(options, "http://localhost:3000"), local);
    expect(readEnrolment(session).passkey!.credential!.rpID).toBe("localhost");
  });
});

describe("recovery codes", () => {
  it("are 10 codes of 12 characters in Better Auth's format", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const value of codes) expect(value).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{7}$/);
    expect(new Set(codes).size).toBe(10);
  });

  it("are confirmed by retyping the one asked for, and are not issued again afterwards", async () => {
    await withAccount();
    const { codes, confirmNumber } = issueRecoveryCodes(session);
    expect(confirmNumber).toBeGreaterThanOrEqual(1);
    expect(confirmNumber).toBeLessThanOrEqual(10);
    const other = codes[confirmNumber % 10];
    expect(await code(() => confirmRecoveryCode(session, other))).toBe("RECOVERY_WRONG");
    confirmRecoveryCode(session, ` ${codes[confirmNumber - 1]} `);
    expect(readEnrolment(session).recovery!.confirmed).toBe(true);
    expect(await code(() => issueRecoveryCodes(session))).toBe("RECOVERY_DONE");
  });
});

describe("organisation and keys", () => {
  it("stages the names (the workspace keeps its internal slug) and the starter-content choice", async () => {
    await withAccount();
    expect(await code(() => stageOrganisation(session, { organisationName: " ", workspaceName: "Main" }))).toBe("FIELD_REQUIRED");
    expect(stageOrganisation(session, { organisationName: "Example Ltd", workspaceName: "Main site", starterContent: true })).toEqual({
      organisationName: "Example Ltd", workspaceName: "Main site", workspaceSlug: "polynovea", starterContent: true,
    });
  });

  it("an operator-supplied master key is not shown; a generated one is, confirmed by its last 6 characters", async () => {
    await withAccount();
    expect(await revealKeys(session, env)).toEqual({ masterKey: null, backupRepoPassword: null, databaseMode: "managed" });

    const fileEnv = { ...env, CMS_MASTER_KEY: undefined };
    loadKeyRing(fileEnv, { generate: true });
    const keys = await revealKeys(session, fileEnv);
    expect(keys.masterKey).toMatch(/^[^:]+:[A-Za-z0-9+/=]+$/);
    expect(await code(confirmKeys(session, { masterKeyTail: "nope00" }, fileEnv))).toBe("MASTER_KEY_TAIL");
    await confirmKeys(session, { masterKeyTail: keys.masterKey!.slice(-6) }, fileEnv);
    expect(await code(revealKeys(session, fileEnv))).toBe("KEYS_DONE");
  });

  it("a database on this server also shows the backup repository password", async () => {
    await withAccount();
    const backupRepoPassword = generateSecret();
    await writeConfig({
      v: 1, databaseMode: "local", database: { host: "127.0.0.1", port: 5432, name: "polynovea", caBundleId: null },
      roles: { owner: { user: "polynovea_owner", password: generateSecret() }, app: { user: "polynovea_app", password: generateSecret() } },
      authSecret: generateSecret(), backupRepoPassword,
    }, env);
    expect(await revealKeys(session, env)).toEqual({ masterKey: null, backupRepoPassword, databaseMode: "local" });
    expect(await code(confirmKeys(session, { backupTail: "xxxxxx" }, env))).toBe("BACKUP_TAIL");
    await confirmKeys(session, { backupTail: backupRepoPassword.slice(-6) }, env);
  });
});

describe("progress", () => {
  it("finalise needs every step; the summary the browser sees holds no secret", async () => {
    await withAccount();
    expect(await code(() => readyEnrolment(readEnrolment(session)))).toBe("STEP_MISSING");

    const enrolled = await enrolOwner(env);
    const state = readEnrolment(enrolled.session);
    expect(readyEnrolment(state).recoveryCodes).toEqual(enrolled.recoveryCodes);
    const summary = JSON.stringify(enrolmentSummary(state));
    for (const secret of [enrolled.totpSecret, state.account!.passwordHash, ...enrolled.recoveryCodes, state.passkey!.credential!.publicKey]) expect(summary).not.toContain(secret);
    expect(enrolmentSummary(state).steps).toEqual({ account: true, authenticator: true, passkey: true, recovery: true, organisation: true, keys: true });
  });
});
