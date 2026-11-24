import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { withSetupHeaders, type SetupTransport } from "./requestGuards";

/**
 * The setup session: what a correct setup code buys, for one browser at a time.
 *
 * - Cookie `__Host-polynovea-setup`: 256 random bits, HttpOnly, Secure, SameSite=Strict, Path=/,
 *   1 hour. Browsers treat http://localhost as secure, so the cookie also works through an SSH tunnel.
 * - State is held on the server, in memory; only a SHA-256 of the cookie value is kept, compared in
 *   constant time. A restart ends the session together with the code.
 * - One active session. Entering the code again takes over: the new browser keeps the wizard's
 *   progress (the state store below), and the old one is told "Setup continued in another browser."
 *
 * For the other wizard steps (db-step, owner-step):
 *
 *   const session = requireSetupSession(request);          // throws SetupSessionError (401)
 *   setSetupState(session, "database", { ... });            // typed by SetupSessionState
 *
 * Add your own keys by augmenting SetupSessionState in your own file:
 *
 *   declare module "@/lib/setup/setupSession" {
 *     interface SetupSessionState { database: DatabaseStepState }
 *   }
 */

export const SETUP_SESSION_COOKIE = "__Host-polynovea-setup";
export const SETUP_SESSION_TTL_MS = 60 * 60 * 1000;
const SUPERSEDED_MEMORY = 20;

export type SetupSessionErrorCode = "SETUP_SESSION_REQUIRED" | "SETUP_SESSION_EXPIRED" | "SETUP_TAKEN_OVER";

const ERROR_MESSAGES: Record<SetupSessionErrorCode, string> = {
  SETUP_SESSION_REQUIRED: "Enter the setup code to continue.",
  SETUP_SESSION_EXPIRED: "Your setup session ran out after an hour. Enter the setup code again to continue.",
  SETUP_TAKEN_OVER: "Setup continued in another browser.",
};

export class SetupSessionError extends Error {
  readonly status = 401;
  readonly code: SetupSessionErrorCode;
  constructor(code: SetupSessionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SetupSessionError";
    this.code = code;
  }
}

export interface SetupSession {
  /** Internal identifier, never the cookie value. */
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** How the browser reached the wizard when it entered the code. */
  readonly transport: SetupTransport;
}

/**
 * The wizard's per-session state, keyed by step. Empty here on purpose: each lane adds its own key
 * by declaration merging (see the header), so this file never has to know their shapes.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SetupSessionState {}

interface ActiveSession {
  session: SetupSession;
  tokenDigest: Buffer;
  state: Partial<SetupSessionState>;
}

interface SessionStore {
  active: ActiveSession | null;
  /** Digests of cookies that were taken over, so their browsers get the takeover message. */
  superseded: Buffer[];
}

const STATE_KEY = Symbol.for("polynovea.setup.session");
const store = globalThis as typeof globalThis & { [STATE_KEY]?: SessionStore };

function sessions(): SessionStore {
  return (store[STATE_KEY] ??= { active: null, superseded: [] });
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface StartedSetupSession {
  session: SetupSession;
  /** The cookie value; set it with setupSessionCookie() and never log it. */
  token: string;
  /** True when this replaced another browser's session. */
  tookOver: boolean;
}

/** Starts the one active session, taking over from any earlier one. Call only after a correct code. */
export function startSetupSession(transport: SetupTransport, now: number = Date.now()): StartedSetupSession {
  const all = sessions();
  const previous = all.active;
  const token = randomBytes(32).toString("base64url");
  const session: SetupSession = Object.freeze({ id: randomUUID(), createdAt: now, expiresAt: now + SETUP_SESSION_TTL_MS, transport });
  let tookOver = false;
  if (previous) {
    if (previous.session.expiresAt > now) tookOver = true;
    all.superseded = [previous.tokenDigest, ...all.superseded].slice(0, SUPERSEDED_MEMORY);
  }
  // The wizard's progress belongs to the install, not the browser: the new session carries it on.
  all.active = { session, tokenDigest: digest(token), state: previous?.state ?? {} };
  return { session, token, tookOver };
}

/** The Set-Cookie value for a new session. */
export function setupSessionCookie(token: string): string {
  return `${SETUP_SESSION_COOKIE}=${token}; Path=/; Max-Age=${SETUP_SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

/** The Set-Cookie value that removes the cookie (for a takeover or an ended session). */
export function clearSetupSessionCookie(): string {
  return `${SETUP_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** The setup cookie's value from a Cookie header, or null. */
export function readSetupSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SETUP_SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

/** Resolves a cookie value to the active session, or throws a SetupSessionError. */
export function setupSessionFromToken(token: string | null, now: number = Date.now()): SetupSession {
  if (!token || token.length > 128) throw new SetupSessionError("SETUP_SESSION_REQUIRED");
  const all = sessions();
  const presented = digest(token);
  if (all.active && same(presented, all.active.tokenDigest)) {
    if (all.active.session.expiresAt <= now) throw new SetupSessionError("SETUP_SESSION_EXPIRED");
    return all.active.session;
  }
  if (all.superseded.some((old) => same(presented, old))) throw new SetupSessionError("SETUP_TAKEN_OVER");
  throw new SetupSessionError("SETUP_SESSION_REQUIRED");
}

/**
 * The active setup session for this request, from the `__Host-polynovea-setup` cookie.
 * Throws SetupSessionError (status 401) when there is none, it expired, or another browser took over.
 */
export function requireSetupSession(request: { headers: Headers }, now: number = Date.now()): SetupSession {
  return setupSessionFromToken(readSetupSessionToken(request.headers.get("cookie")), now);
}

/** True when `session` is still the active, unexpired session. */
export function isActiveSetupSession(session: SetupSession, now: number = Date.now()): boolean {
  const active = sessions().active;
  return active !== null && active.session.id === session.id && active.session.expiresAt > now;
}

function activeFor(session: SetupSession, now: number): ActiveSession {
  const active = sessions().active;
  if (!active || active.session.id !== session.id) throw new SetupSessionError("SETUP_TAKEN_OVER");
  if (active.session.expiresAt <= now) throw new SetupSessionError("SETUP_SESSION_EXPIRED");
  return active;
}

/** Reads one step's state. Throws SetupSessionError if `session` is no longer the active one. */
export function getSetupState<K extends keyof SetupSessionState>(session: SetupSession, key: K, now: number = Date.now()): SetupSessionState[K] | undefined {
  return activeFor(session, now).state[key];
}

/** Writes one step's state. Throws SetupSessionError if `session` is no longer the active one. */
export function setSetupState<K extends keyof SetupSessionState>(session: SetupSession, key: K, value: SetupSessionState[K], now: number = Date.now()): void {
  activeFor(session, now).state[key] = value;
}

/** Removes one step's state. Throws SetupSessionError if `session` is no longer the active one. */
export function deleteSetupState<K extends keyof SetupSessionState>(session: SetupSession, key: K, now: number = Date.now()): void {
  delete activeFor(session, now).state[key];
}

/** Ends the active session (the owner step calls this once the installation row exists). */
export function endSetupSession(): void {
  const all = sessions();
  all.active = null;
  all.superseded = [];
}

/** The JSON 401 for a SetupSessionError, in the API's envelope, with the setup headers. */
export function setupSessionErrorResponse(error: SetupSessionError): Response {
  const response = withSetupHeaders(
    Response.json({ success: false, data: null, error: error.message, code: error.code, timestamp: new Date().toISOString() }, { status: error.status }),
  );
  if (error.code !== "SETUP_SESSION_REQUIRED") response.headers.append("Set-Cookie", clearSetupSessionCookie());
  return response;
}

/** Tests only: forget every session, as a restart would. */
export function resetSetupSessionsForTests(): void {
  delete store[STATE_KEY];
}
