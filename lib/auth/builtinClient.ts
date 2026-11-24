"use client";

/**
 * Browser side of the built-in auth: Better Auth's client with the two-factor and passkey plugins,
 * same-origin only. The session lives in an HttpOnly cookie the browser sends by itself; this
 * module never sees the token. Pages use it for sign-in, MFA and passkey enrolment, and sessions.
 */
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import type { BrowserIdentityProvider, Session, User } from "@/lib/auth/provider";

let client: ReturnType<typeof makeClient> | null = null;

function makeClient() {
  return createAuthClient({
    basePath: "/api/auth",
    plugins: [twoFactorClient(), passkeyClient()],
  });
}

export function builtinAuthClient() {
  client ??= makeClient();
  return client;
}

const SESSION_EVENT = "polynovea:session-changed";

/**
 * Session.accessToken for the built-in auth. The real token stays in the HttpOnly cookie; this is a
 * non-secret marker that a session exists, so pages that check for a token keep working. The admin
 * fetch wrapper strips any Authorization header for the built-in auth, so it never leaves the page.
 */
export const BUILTIN_SESSION_MARKER = "builtin-session";

/**
 * A recent answer to "who is signed in?", reused for a few seconds. Pages ask before nearly every API
 * call (getAuthHeaders), and the server allows 100 session checks a minute per address: a busy page,
 * or a team behind one office connection, ran into that limit. Only successful answers are kept, and
 * any sign-in, sign-out or step-up clears it (announceSessionChange).
 */
const SESSION_REUSE_MS = 10_000;
let recent: { at: number; result: Promise<{ session: Session | null; error: Error | null }> } | null = null;

/** Tell every listener in this tab (and useAdminAccess) that the session changed. */
export function announceSessionChange(): void {
  recent = null;
  window.dispatchEvent(new Event(SESSION_EVENT));
}

type RawSession = { session: { expiresAt: string | Date }; user: { id: string; email: string; emailVerified: boolean; updatedAt: string | Date; metadata?: unknown } };

function toSession(raw: RawSession | null | undefined): Session | null {
  if (!raw?.user) return null;
  const metadata = typeof raw.user.metadata === "string" ? safeJson(raw.user.metadata) : raw.user.metadata;
  const user: User = {
    id: raw.user.id,
    email: raw.user.email ?? null,
    emailConfirmedAt: raw.user.emailVerified ? new Date(raw.user.updatedAt).toISOString() : null,
    metadata: metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {},
  };
  return { accessToken: BUILTIN_SESSION_MARKER, expiresAt: Math.floor(new Date(raw.session.expiresAt).getTime() / 1000), user };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function getBuiltinBrowserIdentityProvider(): BrowserIdentityProvider {
  const auth = builtinAuthClient();
  return {
    async signInWithPassword({ email, password }) {
      const { data, error } = await auth.signIn.email({ email, password });
      if (error) return { session: null, error: new Error(error.message || "Sign-in failed") };
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return { session: null, error: new Error("TWO_FACTOR_REQUIRED") };
      announceSessionChange();
      return this.getSession();
    },
    async getSession() {
      // One request at a time, and a successful answer is reused for SESSION_REUSE_MS (see above).
      if (recent && Date.now() - recent.at < SESSION_REUSE_MS) return recent.result;
      const entry = {
        at: Date.now(),
        result: (async () => {
          const { data, error } = await auth.getSession({ query: { disableCookieCache: true } });
          if (error) return { session: null, error: new Error(error.message || "Could not read the session") };
          return { session: toSession(data as RawSession | null), error: null };
        })(),
      };
      recent = entry;
      const result = await entry.result;
      if (result.error && recent === entry) recent = null;
      return result;
    },
    async refreshSession() {
      return this.getSession();
    },
    async signOut() {
      recent = null;
      const { error } = await auth.signOut();
      announceSessionChange();
      return { error: error ? new Error(error.message || "Sign-out failed") : null };
    },
    onSessionChange(listener) {
      const handler = () => {
        void this.getSession().then(({ session }) => listener(session));
      };
      window.addEventListener(SESSION_EVENT, handler);
      return { unsubscribe: () => window.removeEventListener(SESSION_EVENT, handler) };
    },
  };
}
