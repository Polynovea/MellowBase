import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { base64 } from "@better-auth/utils/base64";
import { createRandomStringGenerator } from "@better-auth/utils/random";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { hashPassword } from "@/lib/auth/betterAuth/passwordHash.mjs";
import { assertAcceptablePassword, PasswordPolicyError, type PwnedRangeFetch } from "@/lib/auth/passwordPolicy.mjs";
import { readConfig, type DatabaseMode } from "@/lib/setup/configStore";
import { masterKeyForOwner } from "@/lib/setup/keyRing";
import { getSetupState, setSetupState, type SetupSession } from "@/lib/setup/setupSession";

/**
 * The owner step of the setup wizard, staged in the setup session (key `owner`). Nothing touches
 * the database until finalise.ts commits everything in one transaction.
 *
 * What is held, and how:
 * - Account: email, display name, username and an Argon2id hash. The password is checked with the
 *   single-factor rules (15+ characters, not breached) and hashed at once; the plaintext is never
 *   stored.
 * - Authenticator app: a TOTP secret made and checked exactly as Better Auth's two-factor plugin
 *   does (lib/auth/betterAuth/server.ts: 6 digits, 30 seconds, issuer "Polynovea CMS").
 * - Passkey, always required: registered with @simplewebauthn/server, user verification required,
 *   rpID and origin taken only from POLYNOVEA_PUBLIC_URL (never the Host header), so the passkey
 *   works with the CMS's own sign-in afterwards.
 * - 10 recovery codes of 12 characters (Better Auth's generator and format), shown once and
 *   confirmed by retyping one picked at random.
 * - Organisation and workspace names, and the optional starter content.
 * - The master key and, for a database on this server, the backup repository password: shown once,
 *   confirmed by retyping their last 6 characters.
 *
 * The state lives in memory with the setup session (an hour, one browser at a time; a takeover keeps
 * it). Secrets in it are encrypted only at the final commit, with the auth secret the CMS will use.
 */

export const TOTP_ISSUER = "Polynovea CMS";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 12;
export const RP_NAME = "Polynovea CMS";
/** The workspace migration 0007 seeds. The app finds its one workspace by this slug (lib/platform/actor.ts). */
export const DEFAULT_WORKSPACE_SLUG = "polynovea";
const PASSKEY_CHALLENGE_MS = 5 * 60 * 1000;
const KEY_TAIL = 6;

export const TEMPORARY_ROUTE_WARNING =
  "Your passkey only works on this address. If the address changes, sign in with your authenticator app and you'll be asked to register a new passkey.";

type Env = Record<string, string | undefined>;

export interface StagedAccount {
  email: string;
  displayName: string;
  username: string;
  passwordHash: string;
}

export interface StagedPasskey {
  credentialID: string;
  /** Base64 of the COSE public key, exactly as Better Auth's passkey plugin stores it. */
  publicKey: string;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string;
  aaguid: string | null;
  rpID: string;
}

export interface StagedOrganisation {
  organisationName: string;
  workspaceName: string;
  workspaceSlug: string;
  starterContent: boolean;
}

export interface OwnerEnrolmentState {
  account?: StagedAccount;
  totp?: { secret: string; confirmed: boolean };
  passkey?: { challenge?: { value: string; expiresAt: number; rpID: string }; credential?: StagedPasskey };
  recovery?: { codes: string[]; confirmIndex: number; confirmed: boolean };
  organisation?: StagedOrganisation;
  keys?: { confirmed: boolean };
}

declare module "@/lib/setup/setupSession" {
  interface SetupSessionState {
    owner: OwnerEnrolmentState;
  }
}

/** A refusal the wizard shows the person as it is (no secrets, no internals). */
export class EnrolmentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "EnrolmentError";
    this.code = code;
    this.status = status;
  }
}

export function readEnrolment(session: SetupSession): OwnerEnrolmentState {
  return getSetupState(session, "owner") ?? {};
}

function save(session: SetupSession, state: OwnerEnrolmentState): void {
  setSetupState(session, "owner", state);
}

// ── Public address (passkeys) ────────────────────────────────────────────────

export interface PublicAddress {
  origin: string;
  rpID: string;
  /** localhost and other loopback names: an SSH tunnel or a trial, not the address the CMS will keep. */
  temporary: boolean;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** rpID and origin come only from POLYNOVEA_PUBLIC_URL, never from the request. */
export function publicAddress(env: Env = process.env): PublicAddress {
  const raw = env.POLYNOVEA_PUBLIC_URL?.trim();
  if (!raw) throw new EnrolmentError("PUBLIC_URL_MISSING", "POLYNOVEA_PUBLIC_URL is not set, so a passkey can't be registered. Set it to the address you use for the CMS and restart.", 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnrolmentError("PUBLIC_URL_INVALID", "POLYNOVEA_PUBLIC_URL is not a valid web address.", 500);
  }
  const host = url.hostname.toLowerCase();
  const temporary = LOOPBACK.has(host) || host.endsWith(".localhost");
  if (url.protocol !== "https:" && !temporary) throw new EnrolmentError("PUBLIC_URL_INSECURE", "POLYNOVEA_PUBLIC_URL must start with https:// (or be a localhost address).", 500);
  return { origin: url.origin, rpID: url.hostname, temporary };
}

// ── Account ──────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] || "owner";
  const normalized = local.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = (normalized || "owner").slice(0, 40);
  return name.length >= 3 ? name : `${name}-owner`.slice(0, 40);
}

function cleanText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) throw new EnrolmentError("FIELD_REQUIRED", `Enter ${field}.`);
  if (text.length > max) throw new EnrolmentError("FIELD_TOO_LONG", `Keep ${field} to ${max} characters or fewer.`);
  return text;
}

/**
 * Checks and hashes the password (the plaintext goes no further than this call) and stages the
 * account. A different email clears the authenticator app and passkey, which were made for the old one.
 */
export async function stageAccount(
  session: SetupSession,
  input: { email: unknown; displayName: unknown; password: unknown },
  options: { pwnedLookup?: PwnedRangeFetch } = {},
): Promise<{ email: string; displayName: string }> {
  const email = cleanText(input.email, "your email address", 254).toLowerCase();
  if (!EMAIL.test(email)) throw new EnrolmentError("EMAIL_INVALID", "Enter a valid email address.");
  const displayName = cleanText(input.displayName, "your name", 120);
  const password = typeof input.password === "string" ? input.password : "";
  try {
    await assertAcceptablePassword({ password, hasMfa: false, email, lookup: options.pwnedLookup });
  } catch (error) {
    if (error instanceof PasswordPolicyError) throw new EnrolmentError("PASSWORD_POLICY", error.message);
    throw error;
  }
  const passwordHash = await hashPassword(password);

  const state = readEnrolment(session);
  const emailChanged = state.account && state.account.email !== email;
  save(session, {
    ...state,
    account: { email, displayName, username: usernameFromEmail(email), passwordHash },
    ...(emailChanged ? { totp: undefined, passkey: undefined } : {}),
  });
  return { email, displayName };
}

function requireAccount(state: OwnerEnrolmentState): StagedAccount {
  if (!state.account) throw new EnrolmentError("ACCOUNT_FIRST", "Start with your account details.", 409);
  return state.account;
}

// ── Authenticator app (TOTP) ─────────────────────────────────────────────────

// Better Auth's own generator for TOTP secrets: 32 characters, used as raw bytes.
const totpSecretString = createRandomStringGenerator("a-z", "0-9", "A-Z", "-_");

function totp(secret: string) {
  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD });
}

/** A new secret (replacing any earlier one) and its otpauth:// address for the QR code. */
export function startTotp(session: SetupSession): { totpURI: string } {
  const state = readEnrolment(session);
  const account = requireAccount(state);
  const secret = totpSecretString(32);
  save(session, { ...state, totp: { secret, confirmed: false } });
  return { totpURI: totp(secret).url(TOTP_ISSUER, account.email) };
}

export async function confirmTotp(session: SetupSession, code: unknown): Promise<void> {
  const state = readEnrolment(session);
  requireAccount(state);
  if (!state.totp) throw new EnrolmentError("TOTP_NOT_STARTED", "Scan the QR code first.", 409);
  const typed = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(typed)) throw new EnrolmentError("TOTP_FORMAT", "Enter the 6-digit code your authenticator app shows.");
  if (!(await totp(state.totp.secret).verify(typed))) {
    throw new EnrolmentError("TOTP_WRONG", "That code didn't match. Check the time on your phone is set automatically, then try the newest code.");
  }
  save(session, { ...readEnrolment(session), totp: { secret: state.totp.secret, confirmed: true } });
}

// ── Passkey ──────────────────────────────────────────────────────────────────

const webauthnUserId = createRandomStringGenerator("a-z", "0-9");

export async function passkeyRegistrationOptions(
  session: SetupSession,
  env: Env = process.env,
  now: number = Date.now(),
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; temporary: boolean; warning: string | null }> {
  const state = readEnrolment(session);
  const account = requireAccount(state);
  const address = publicAddress(env);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: address.rpID,
    userID: new TextEncoder().encode(webauthnUserId(32)),
    userName: account.email,
    userDisplayName: account.displayName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: PASSKEY_CHALLENGE_MS,
  });
  save(session, {
    ...state,
    passkey: { ...state.passkey, challenge: { value: options.challenge, expiresAt: now + PASSKEY_CHALLENGE_MS, rpID: address.rpID } },
  });
  return { options, temporary: address.temporary, warning: address.temporary ? TEMPORARY_ROUTE_WARNING : null };
}

export async function verifyPasskeyRegistration(
  session: SetupSession,
  response: unknown,
  env: Env = process.env,
  now: number = Date.now(),
): Promise<void> {
  const state = readEnrolment(session);
  requireAccount(state);
  const challenge = state.passkey?.challenge;
  // One use per challenge, whatever the outcome.
  save(session, { ...state, passkey: { ...state.passkey, challenge: undefined } });
  if (!challenge || challenge.expiresAt < now) throw new EnrolmentError("PASSKEY_CHALLENGE", "The passkey request ran out. Try adding the passkey again.", 409);
  const address = publicAddress(env);
  if (address.rpID !== challenge.rpID) throw new EnrolmentError("PASSKEY_CHALLENGE", "The CMS address changed. Try adding the passkey again.", 409);
  if (!response || typeof response !== "object") throw new EnrolmentError("PASSKEY_RESPONSE", "Your browser didn't send a passkey. Try again.");

  const body = response as RegistrationResponseJSON;
  const verification = await verifyRegistrationResponse({
    response: body,
    expectedChallenge: challenge.value,
    expectedOrigin: address.origin,
    expectedRPID: address.rpID,
    requireUserVerification: true,
  }).catch(() => null);
  const info = verification?.registrationInfo;
  if (!verification?.verified || !info) {
    throw new EnrolmentError("PASSKEY_REJECTED", "That passkey couldn't be checked. Use a device that asks for your fingerprint, face or PIN, and try again.");
  }
  const credential: StagedPasskey = {
    credentialID: info.credential.id,
    publicKey: base64.encode(info.credential.publicKey),
    counter: info.credential.counter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    transports: body.response?.transports?.join(",") ?? "",
    aaguid: info.aaguid ?? null,
    rpID: address.rpID,
  };
  const latest = readEnrolment(session);
  save(session, { ...latest, passkey: { credential } });
}

// ── Recovery codes ───────────────────────────────────────────────────────────

const recoveryCodeString = createRandomStringGenerator("a-z", "0-9", "A-Z");

/** Better Auth's format: 12 random characters shown as xxxxx-xxxxxxx. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = recoveryCodeString(RECOVERY_CODE_LENGTH);
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** New codes (replacing unconfirmed ones). Returned only here: no later call shows them again. */
export function issueRecoveryCodes(session: SetupSession): { codes: string[]; confirmNumber: number } {
  const state = readEnrolment(session);
  requireAccount(state);
  if (state.recovery?.confirmed) throw new EnrolmentError("RECOVERY_DONE", "Your recovery codes are already saved.", 409);
  const codes = generateRecoveryCodes();
  const confirmIndex = randomInt(RECOVERY_CODE_COUNT);
  save(session, { ...state, recovery: { codes, confirmIndex, confirmed: false } });
  return { codes, confirmNumber: confirmIndex + 1 };
}

function sameText(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function confirmRecoveryCode(session: SetupSession, typed: unknown): void {
  const state = readEnrolment(session);
  if (!state.recovery) throw new EnrolmentError("RECOVERY_NOT_ISSUED", "Show your recovery codes first.", 409);
  const value = typeof typed === "string" ? typed.trim() : "";
  if (!sameText(value, state.recovery.codes[state.recovery.confirmIndex])) {
    throw new EnrolmentError("RECOVERY_WRONG", `That isn't code number ${state.recovery.confirmIndex + 1}. Type it exactly as shown, including the dash.`);
  }
  save(session, { ...state, recovery: { ...state.recovery, confirmed: true } });
}

// ── Organisation, workspace, starter content ─────────────────────────────────

export function stageOrganisation(
  session: SetupSession,
  input: { organisationName: unknown; workspaceName: unknown; starterContent?: unknown },
): StagedOrganisation {
  const state = readEnrolment(session);
  requireAccount(state);
  const organisation: StagedOrganisation = {
    organisationName: cleanText(input.organisationName, "your organisation's name", 200),
    workspaceName: cleanText(input.workspaceName, "a workspace name", 120),
    workspaceSlug: DEFAULT_WORKSPACE_SLUG,
    starterContent: input.starterContent === true,
  };
  save(session, { ...state, organisation });
  return organisation;
}

// ── Keys shown once ──────────────────────────────────────────────────────────

export interface KeysToShow {
  /** `kid:base64`, or null when the operator supplied CMS_MASTER_KEY (they already hold it). */
  masterKey: string | null;
  /** pgBackRest repository password, only for a database on this server. */
  backupRepoPassword: string | null;
  databaseMode: DatabaseMode;
}

export async function keysForOwner(env: Env = process.env): Promise<KeysToShow> {
  const config = await readConfig(env);
  return {
    masterKey: masterKeyForOwner(env),
    backupRepoPassword: config?.databaseMode === "local" ? config.backupRepoPassword : null,
    databaseMode: config?.databaseMode ?? "managed",
  };
}

/** Shows the keys until they are confirmed; never afterwards. */
export async function revealKeys(session: SetupSession, env: Env = process.env): Promise<KeysToShow> {
  const state = readEnrolment(session);
  requireAccount(state);
  if (state.keys?.confirmed) throw new EnrolmentError("KEYS_DONE", "You've already saved your keys. They aren't shown again.", 409);
  return keysForOwner(env);
}

export async function confirmKeys(session: SetupSession, input: { masterKeyTail?: unknown; backupTail?: unknown }, env: Env = process.env): Promise<void> {
  const state = readEnrolment(session);
  requireAccount(state);
  const keys = await keysForOwner(env);
  const tail = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  if (keys.masterKey && !sameText(tail(input.masterKeyTail), keys.masterKey.slice(-KEY_TAIL))) {
    throw new EnrolmentError("MASTER_KEY_TAIL", "The last 6 characters of the master key don't match. Check your saved copy.");
  }
  if (keys.backupRepoPassword && !sameText(tail(input.backupTail), keys.backupRepoPassword.slice(-KEY_TAIL))) {
    throw new EnrolmentError("BACKUP_TAIL", "The last 6 characters of the backup password don't match. Check your saved copy.");
  }
  save(session, { ...state, keys: { confirmed: true } });
}

// ── Progress ─────────────────────────────────────────────────────────────────

export type OwnerStepId = "account" | "authenticator" | "passkey" | "recovery" | "organisation" | "keys";
export const OWNER_STEPS: readonly OwnerStepId[] = ["account", "authenticator", "passkey", "recovery", "organisation", "keys"];

export function completedSteps(state: OwnerEnrolmentState): Record<OwnerStepId, boolean> {
  return {
    account: Boolean(state.account),
    authenticator: Boolean(state.totp?.confirmed),
    passkey: Boolean(state.passkey?.credential),
    recovery: Boolean(state.recovery?.confirmed),
    organisation: Boolean(state.organisation),
    keys: Boolean(state.keys?.confirmed),
  };
}

/** What the browser may see: progress and labels, never a secret. */
export function enrolmentSummary(state: OwnerEnrolmentState) {
  return {
    steps: completedSteps(state),
    email: state.account?.email ?? null,
    displayName: state.account?.displayName ?? null,
    organisation: state.organisation ? { organisationName: state.organisation.organisationName, workspaceName: state.organisation.workspaceName, starterContent: state.organisation.starterContent } : null,
  };
}

export interface ReadyEnrolment {
  account: StagedAccount;
  totpSecret: string;
  passkey: StagedPasskey;
  recoveryCodes: string[];
  organisation: StagedOrganisation;
}

/** Everything finalise needs, or an error naming the first step still to do. */
export function readyEnrolment(state: OwnerEnrolmentState): ReadyEnrolment {
  const done = completedSteps(state);
  const missing = OWNER_STEPS.find((step) => !done[step]);
  if (missing) throw new EnrolmentError("STEP_MISSING", `Finish the "${missing}" step first.`, 409);
  return {
    account: state.account!,
    totpSecret: state.totp!.secret,
    passkey: state.passkey!.credential!,
    recoveryCodes: state.recovery!.codes,
    organisation: state.organisation!,
  };
}
