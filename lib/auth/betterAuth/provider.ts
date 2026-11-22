/**
 * ServerIdentityProvider on Better Auth (phase 0 spike).
 *
 * Fits the interface without forking the library: sessions are checked through auth.api.getSession,
 * and admin-side user management goes through the documented $context.internalAdapter.
 *
 * Interface finding: Better Auth is cookie-first. The "bearer token" here is the signed session
 * cookie value; the browser cannot read it (HttpOnly), so BrowserIdentityProvider's
 * Session.accessToken has no Better Auth equivalent. Phase 1 should change the server interface to
 * verifyRequest(request) and move the admin UI's API client to the session cookie (the plan already
 * schedules that), rather than adding the bearer plugin.
 */
import type { ServerIdentityProvider, User } from "@/lib/auth/provider";
import { hashPassword } from "@/lib/auth/betterAuth/passwordHash";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type PolynoveaAuth } from "@/lib/auth/betterAuth/server";

type BetterAuthUser = { id: string; email: string; emailVerified: boolean; updatedAt: Date | string; metadata?: unknown };

function toIdentityUser(user: BetterAuthUser): User {
  const metadata = typeof user.metadata === "string" ? safeJson(user.metadata) : user.metadata;
  return {
    id: user.id,
    email: user.email ?? null,
    // Better Auth records only whether the address is verified, not when; the last update is the closest time.
    emailConfirmedAt: user.emailVerified ? new Date(user.updatedAt).toISOString() : null,
    metadata: metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {},
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

const genericError = (message: string) => new Error(message);

// A Better Auth session cookie value is the token, a dot and its base64 signature (it may arrive
// URL-encoded). Anything else, such as a ";" or a newline, is rejected before it reaches a Cookie
// header, where it could add or split cookies.
const SESSION_TOKEN = /^[A-Za-z0-9._~+/=%-]{1,512}$/;

export function getBetterAuthServerIdentityProvider(auth: PolynoveaAuth): ServerIdentityProvider {
  return {
    async verifyBearerToken(token) {
      if (typeof token !== "string" || !SESSION_TOKEN.test(token)) return { user: null, error: genericError("Invalid session") };
      try {
        const ctx = await auth.$context;
        const headers = new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${token}` });
        const result = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
        if (!result) return { user: null, error: genericError("Invalid session") };
        return { user: toIdentityUser(result.user as BetterAuthUser), error: null };
      } catch {
        return { user: null, error: genericError("Invalid session") };
      }
    },

    async createUser(input) {
      if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
        return { user: null, error: genericError(`Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`) };
      }
      let createdUserId: string | null = null;
      try {
        const ctx = await auth.$context;
        const user = await ctx.internalAdapter.createUser({
          email: input.email.trim().toLowerCase(),
          name: typeof input.metadata?.display_name === "string" ? input.metadata.display_name : input.email,
          emailVerified: input.emailConfirmed,
          metadata: input.metadata ?? {},
        }, { method: "admin" });
        createdUserId = user.id;
        await ctx.internalAdapter.linkAccount({
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await hashPassword(input.password),
        });
        return { user: toIdentityUser(user as BetterAuthUser), error: null };
      } catch {
        // The user row and its password are two writes. If the second failed, remove the first, so a
        // retry with the same email does not hit a passwordless account that cannot sign in.
        if (createdUserId) {
          try {
            const ctx = await auth.$context;
            await ctx.internalAdapter.deleteUser(createdUserId);
          } catch {
            // Nothing more to do here; the caller sees the failure either way.
          }
        }
        return { user: null, error: genericError("Could not create user") };
      }
    },

    async updateUser(id, input) {
      if (input.password !== undefined && (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > MAX_PASSWORD_LENGTH)) {
        return { error: genericError(`Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`) };
      }
      try {
        const ctx = await auth.$context;
        if (input.password) {
          await ctx.internalAdapter.updatePassword(id, await hashPassword(input.password));
          // A password change signs the user out everywhere.
          await ctx.internalAdapter.deleteUserSessions(id);
        }
        if (input.metadata) await ctx.internalAdapter.updateUser(id, { metadata: input.metadata });
        return { error: null };
      } catch {
        return { error: genericError("Could not update user") };
      }
    },

    async deleteUser(id) {
      try {
        const ctx = await auth.$context;
        await ctx.internalAdapter.deleteUserSessions(id);
        await ctx.internalAdapter.deleteUser(id);
        return { error: null };
      } catch {
        return { error: genericError("Could not delete user") };
      }
    },
  };
}
