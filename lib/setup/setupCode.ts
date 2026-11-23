import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one-time setup code (design doc, "First-run setup wizard"; implementation plan, Phase 2).
 *
 * - 128 random bits from randomBytes(16), shown as 26 Crockford base32 characters in groups.
 * - Kept only as a SHA-256 digest. Argon2id was rejected on purpose: a 128-bit code cannot be
 *   brute-forced, so a slow hash adds nothing, and 19 MiB per attempt would turn this public
 *   endpoint into a memory-exhaustion target.
 * - Checked with timingSafeEqual on two 32-byte digests, after normalising what was typed (case,
 *   separators, Crockford look-alikes I/L→1 and O→0). Every input, right or wrong, expired or never
 *   issued, takes the same path: one hash, one comparison.
 * - Valid for 1 hour after it is issued; a restart issues a new one.
 * - POLYNOVEA_SETUP_CODE lets an automated deploy supply the code. It must carry at least 128 bits
 *   (26+ base32 or 22+ base64 characters) or boot refuses it. Once read it is hashed and deleted
 *   from process.env, and it expires like a generated code.
 *
 * State lives on globalThis, so the instrumentation bundle that issues the code and the route
 * bundle that checks it share one copy. It is never written anywhere else.
 */

export const SETUP_CODE_TTL_MS = 60 * 60 * 1000;
export const SETUP_CODE_ENV = "POLYNOVEA_SETUP_CODE";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 26;
const MIN_BASE64_LENGTH = 22;
/** A random 26-character code repeats this few distinct symbols with odds below 1 in 10^10. */
const MIN_DISTINCT_SYMBOLS = 8;

type Env = Record<string, string | undefined>;
type CodeFormat = "base32" | "base64";

export interface IssuedSetupCode {
  /** The grouped code to print, or null when the operator supplied it (it is never echoed). */
  display: string | null;
  source: "generated" | "environment";
  issuedAt: number;
  expiresAt: number;
}

interface CodeState {
  digest: Buffer;
  format: CodeFormat;
  issuedAt: number;
  expiresAt: number;
}

const STATE_KEY = Symbol.for("polynovea.setup.code");
const store = globalThis as typeof globalThis & { [STATE_KEY]?: CodeState };

/** Compared against when no code is live, so a missing code costs the same as a wrong one. */
const DUMMY_DIGEST = createHash("sha256").update(randomBytes(32)).digest();

export class SetupCodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupCodeConfigError";
  }
}

/** Crockford base32 of 16 bytes: 130 bits of room, so the first character is always 0–7. */
export function encodeCrockford(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const length = Math.ceil((bytes.length * 8) / 5);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** 26 characters as 6-5-5-5-5, so it can be read aloud and checked by eye. */
export function formatSetupCode(code: string): string {
  return [code.slice(0, 6), code.slice(6, 11), code.slice(11, 16), code.slice(16, 21), code.slice(21)].filter(Boolean).join("-");
}

/** What a person typed, as the canonical base32 string: upper case, no separators, I/L→1, O→0. */
export function normaliseSetupCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

function canonical(input: string, format: CodeFormat): string {
  // Base64 is case-sensitive, so only surrounding whitespace is forgiven there.
  return format === "base32" ? normaliseSetupCode(input) : input.trim().replace(/=+$/, "");
}

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Checks an operator-supplied code and says how to compare it. Throws a SetupCodeConfigError that
 * names the rule but never repeats the value.
 */
export function classifyEnvironmentCode(raw: string): CodeFormat {
  const asBase32 = normaliseSetupCode(raw);
  const asBase64 = raw.trim().replace(/=+$/, "");
  // Base64 is assumed only when the value uses what base32 cannot: both letter cases, or + / _.
  // Anything else is judged as base32, so 25 single-case characters (125 bits) cannot pass as base64.
  const usesBase64Only = (/[a-z]/.test(asBase64) && /[A-Z]/.test(asBase64)) || /[+/_]/.test(asBase64);
  let format: CodeFormat | null = null;
  if (asBase32.length >= CODE_LENGTH && [...asBase32].every((c) => CROCKFORD.includes(c))) format = "base32";
  else if (usesBase64Only && asBase64.length >= MIN_BASE64_LENGTH && /^[A-Za-z0-9+/_-]+$/.test(asBase64)) format = "base64";
  if (!format) {
    throw new SetupCodeConfigError(
      `${SETUP_CODE_ENV} is too weak: it needs at least 128 bits, which is 26 or more base32 characters or 22 or more base64 characters. Leave it unset to have the CMS generate one.`,
    );
  }
  const symbols = new Set(canonical(raw, format)).size;
  if (symbols < MIN_DISTINCT_SYMBOLS) {
    throw new SetupCodeConfigError(`${SETUP_CODE_ENV} does not look random (too few different characters). Generate it with a password manager or \`openssl rand -base64 18\`.`);
  }
  return format;
}

/**
 * Issues the code for this boot. Uses POLYNOVEA_SETUP_CODE when set (then deletes it from `env`),
 * otherwise generates one. Replaces any earlier code.
 */
export function issueSetupCode(options: { env?: Env; now?: number } = {}): IssuedSetupCode {
  const env = options.env ?? process.env;
  const issuedAt = options.now ?? Date.now();
  const expiresAt = issuedAt + SETUP_CODE_TTL_MS;
  const supplied = env[SETUP_CODE_ENV];

  if (supplied !== undefined && supplied.trim() !== "") {
    // Removed before any check can throw, so a refused value does not linger in the environment either.
    delete env[SETUP_CODE_ENV];
    const format = classifyEnvironmentCode(supplied);
    store[STATE_KEY] = { digest: digestOf(canonical(supplied, format)), format, issuedAt, expiresAt };
    return { display: null, source: "environment", issuedAt, expiresAt };
  }

  delete env[SETUP_CODE_ENV];
  const code = encodeCrockford(randomBytes(16));
  store[STATE_KEY] = { digest: digestOf(code), format: "base32", issuedAt, expiresAt };
  return { display: formatSetupCode(code), source: "generated", issuedAt, expiresAt };
}

export type SetupCodeAnnouncer = (issued: IssuedSetupCode) => void;

function defaultAnnouncer(issued: IssuedSetupCode): void {
  const expires = new Date(issued.expiresAt).toISOString();
  if (issued.display) console.info(`[setup] Setup code: ${issued.display}  (valid until ${expires}; a restart issues a new one)`);
  else console.info(`[setup] Setup code: the one supplied in ${SETUP_CODE_ENV} (valid until ${expires}).`);
}

/**
 * Boot entry point: issue the code and log it once. Until boot wiring lands, the announcer prints
 * on its own; bootTasks will pass one that goes through announceSetupAccess().
 */
export function issueAndPrintSetupCode(options: { env?: Env; now?: number; announce?: SetupCodeAnnouncer } = {}): IssuedSetupCode {
  const issued = issueSetupCode(options);
  (options.announce ?? defaultAnnouncer)(issued);
  return issued;
}

/**
 * True only for the live code, before it expires. One digest and one timingSafeEqual on every call,
 * whatever the input, so a wrong, expired or absent code cannot be told apart by timing.
 */
export function verifySetupCode(input: unknown, now: number = Date.now()): boolean {
  const state = store[STATE_KEY];
  const text = typeof input === "string" ? input.slice(0, 256) : "";
  const candidate = digestOf(canonical(text, state?.format ?? "base32"));
  const matches = timingSafeEqual(candidate, state?.digest ?? DUMMY_DIGEST);
  return matches && state !== undefined && text.length > 0 && now < state.expiresAt;
}

/** When the live code stops working, or null if none was issued. */
export function setupCodeExpiresAt(): number | null {
  return store[STATE_KEY]?.expiresAt ?? null;
}

/** Tests only: forget the code, as a restart would. */
export function resetSetupCodeForTests(): void {
  delete store[STATE_KEY];
}
