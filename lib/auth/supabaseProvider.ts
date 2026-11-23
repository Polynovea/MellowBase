import type { Session as SupabaseSession, User as SupabaseUser } from "@supabase/supabase-js";
import type { BrowserIdentityProvider, RequestIdentity, ServerIdentityProvider, Session, User } from "@/lib/auth/provider";
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { supabase } from "@/lib/supabase";

const toError = (error: { message: string } | null): Error | null => error ? new Error(error.message) : null;

/** GoTrue's user, reduced to the CMS's neutral identity type. */
export function toIdentityUser(user: SupabaseUser | null | undefined): User | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    metadata: user.user_metadata && typeof user.user_metadata === "object" ? { ...user.user_metadata } : {},
  };
}

/** GoTrue's session, reduced to the CMS's neutral session type. */
export function toIdentitySession(session: SupabaseSession | null | undefined): Session | null {
  if (!session) return null;
  const user = toIdentityUser(session.user);
  if (!user) return null;
  return { accessToken: session.access_token, expiresAt: session.expires_at ?? null, user };
}

/** Current first-class identity adapter. It is intentionally named rather
 * than hidden so unsupported providers are never mistaken for working ones. */
export function getSupabaseBrowserIdentityProvider(): BrowserIdentityProvider {
  return {
    async signInWithPassword(input) {
      const { data, error } = await supabase.auth.signInWithPassword(input);
      return { session: toIdentitySession(data.session), error: toError(error) };
    },
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      return { session: toIdentitySession(data.session), error: toError(error) };
    },
    async refreshSession() {
      const { data, error } = await supabase.auth.refreshSession();
      return { session: toIdentitySession(data.session), error: toError(error) };
    },
    async signOut() {
      const { error } = await supabase.auth.signOut();
      return { error: toError(error) };
    },
    onSessionChange(listener) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => listener(toIdentitySession(session)));
      return { unsubscribe: () => subscription.unsubscribe() };
    },
  };
}

/** The bearer token from an `Authorization: Bearer` header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/** Claims of a JWT, read without checking it. Only call this on a token GoTrue has already verified. */
function unverifiedClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/**
 * When the user last authenticated, from the `amr` claim of a GoTrue access token that GoTrue has
 * already verified. Refreshing a token keeps the original `amr` timestamps, so this is the sign-in
 * time, not the refresh time. Null when the claim is missing or malformed (step-up then fails closed).
 */
export function authenticatedAtFromAccessToken(token: string): Date | null {
  const amr = unverifiedClaims(token)?.amr;
  if (!Array.isArray(amr)) return null;
  const times = amr
    .map((entry) => (entry && typeof entry === "object" ? (entry as { timestamp?: unknown }).timestamp : null))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return times.length ? new Date(Math.max(...times) * 1000) : null;
}

export function getSupabaseServerIdentityProvider(): ServerIdentityProvider {
  const client = createServiceRoleClient();
  return {
    async verifyRequest(request) {
      const token = bearerToken(request);
      if (!token) return { identity: null, error: new Error("Missing Authorization token") };
      const { data, error } = await client.auth.getUser(token);
      const user = toIdentityUser(data.user);
      if (error || !user) return { identity: null, error: toError(error) ?? new Error("Invalid session") };
      // Claims are read only after GoTrue has verified the token above.
      const sessionId = unverifiedClaims(token)?.session_id;
      const identity: RequestIdentity = {
        user,
        sessionId: typeof sessionId === "string" ? sessionId : null,
        authenticatedAt: authenticatedAtFromAccessToken(token),
        transport: "bearer",
        authenticators: null,
      };
      return { identity, error: null };
    },
    async createUser(input) {
      const { data, error } = await client.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: input.emailConfirmed,
        user_metadata: input.metadata,
      });
      return { user: toIdentityUser(data.user), error: toError(error) };
    },
    async updateUser(id, input) {
      const { error } = await client.auth.admin.updateUserById(id, {
        ...(input.password ? { password: input.password } : {}),
        ...(input.metadata ? { user_metadata: input.metadata } : {}),
      });
      return { error: toError(error) };
    },
    async deleteUser(id) {
      const { error } = await client.auth.admin.deleteUser(id);
      return { error: toError(error) };
    },
    async revokeUserSessions() {
      // GoTrue's admin API can only sign out a session it is handed a token for; the browser signs
      // itself out everywhere instead (signOut with scope "global"). Built-in auth supports this server-side.
      return { error: new Error("Signing a user out everywhere needs the built-in auth") };
    },
  };
}
