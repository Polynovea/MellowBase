/**
 * ServerIdentityProvider on Better Auth.
 *
 * Fits the interface without forking the library: sessions are checked through auth.api.getSession
 * (database only; the cookie cache is off), and admin-side user management goes through the
 * documented $context.internalAdapter. Better Auth is cookie-first, so verifyRequest reads the
 * session cookie from the request; the browser never sees the token (HttpOnly).
 */
import type { RequestIdentity, ServerIdentityProvider, User } from "@/lib/auth/provider";
import { hashPassword } from "@/lib/auth/betterAuth/passwordHash";
import { ABSOLUTE_TIMEOUT_SECONDS, type PolynoveaAuth } from "@/lib/auth/betterAuth/server";
import { assertAcceptablePassword, PasswordPolicyError, type PwnedRangeFetch } from "@/lib/auth/passwordPolicy";

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

type BetterAuthSession = { id: string; createdAt: Date | string };

/** The password rules, as a provider error (the policy message is safe to show the user). */
async function passwordProblem(input: { password: string; hasMfa: boolean; email: string | null; lookup?: PwnedRangeFetch }): Promise<Error | null> {
  try {
    await assertAcceptablePassword(input);
    return null;
  } catch (error) {
    return error instanceof PasswordPolicyError ? genericError(error.message) : genericError("Could not check the password");
  }
}

export function getBetterAuthServerIdentityProvider(auth: PolynoveaAuth, options: { pwnedLookup?: PwnedRangeFetch } = {}): ServerIdentityProvider {
  const hasMfa = async (userId: string): Promise<boolean> => {
    const ctx = await auth.$context;
    const user = (await ctx.internalAdapter.findUserById(userId)) as { twoFactorEnabled?: boolean | null } | null;
    if (user?.twoFactorEnabled) return true;
    return (await ctx.adapter.count({ model: "passkey", where: [{ field: "userId", value: userId }] })) > 0;
  };

  return {
    async verifyRequest(request) {
      const cookie = request.headers.get("cookie");
      if (!cookie) return { identity: null, error: genericError("Missing session") };
      try {
        // Only the Cookie header is passed on; nothing else in the request is trusted here.
        const result = await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } });
        if (!result) return { identity: null, error: genericError("Invalid session") };
        const session = result.session as BetterAuthSession;
        // The update hook already caps expiry at 7 days from sign-in; this check holds even if it did not run.
        if (Date.now() - new Date(session.createdAt).getTime() > ABSOLUTE_TIMEOUT_SECONDS * 1000) {
          await (await auth.$context).internalAdapter.deleteSession((result.session as { token: string }).token);
          return { identity: null, error: genericError("Invalid session") };
        }
        const identity: RequestIdentity = {
          user: toIdentityUser(result.user as BetterAuthUser),
          sessionId: session.id,
          // Every sign-in (and every step-up re-authentication) creates a new session, so its
          // creation time is when the user last proved who they are.
          authenticatedAt: new Date(session.createdAt),
          transport: "cookie",
        };
        return { identity, error: null };
      } catch {
        return { identity: null, error: genericError("Invalid session") };
      }
    },

    async createUser(input) {
      // A new account has no second factor yet, so the single-factor rule (15 characters) applies.
      const problem = await passwordProblem({ password: input.password, hasMfa: false, email: input.email, lookup: options.pwnedLookup });
      if (problem) return { user: null, error: problem };
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
      if (input.password !== undefined) {
        let mfa = false;
        let email: string | null = null;
        try {
          mfa = await hasMfa(id);
          email = ((await (await auth.$context).internalAdapter.findUserById(id)) as { email?: string } | null)?.email ?? null;
        } catch {
          return { error: genericError("Could not update user") };
        }
        const problem = await passwordProblem({ password: input.password, hasMfa: mfa, email, lookup: options.pwnedLookup });
        if (problem) return { error: problem };
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

    async revokeUserSessions(id) {
      try {
        const ctx = await auth.$context;
        await ctx.internalAdapter.deleteUserSessions(id);
        return { error: null };
      } catch {
        return { error: genericError("Could not sign the user out") };
      }
    },
  };
}
