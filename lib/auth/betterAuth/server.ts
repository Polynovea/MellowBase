/**
 * The built-in auth: Better Auth (pinned 1.7.27), configured to the CMS's rules rather than the
 * library's defaults (design doc, "Built-in auth"; plan, "Phase 1: built-in auth").
 *
 * - Tables in the `polynovea_auth` schema (migration 0071), through the same Kysely instance and
 *   pool as lib/db. User IDs are UUIDs, so admin_users.auth_user_id keeps working and users moved
 *   from GoTrue keep theirs.
 * - Plugins: two-factor (TOTP + 10 recovery codes), passkey (strict origin, user verification
 *   required) and admin (bans; impersonation of admins off). Nothing else.
 * - Argon2id hashing; GoTrue bcrypt hashes verify and are replaced at the next sign-in.
 * - Password rules from lib/auth/passwordPolicy.ts (15 characters, or 8 with MFA; breached check).
 * - Sessions in the database only, cookie cache off (Better Auth's November 2026 advisory). Cookies
 *   are `__Host-`, HttpOnly, Secure, SameSite=Lax. 12-hour idle and 7-day absolute timeouts. Every
 *   sign-in creates a new session and ends the one the browser had, so the session ID changes on
 *   login and a step-up re-authentication never leaves the old session behind.
 * - Rate limits stored in the database; client IPs read from X-Forwarded-For only through the
 *   configured trusted proxies, and IPv6 addresses bucketed per /64. Sign-in is also throttled per
 *   account.
 * - No public sign-up: accounts come from the setup wizard and admins (provider.ts createUser).
 * - Telemetry off.
 */
import { createHash } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { sql, type Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { AuthDateColumnsPlugin } from "@/lib/auth/betterAuth/dateColumns";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/betterAuth/passwordHash";
import { assertAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH_WITH_MFA, PasswordPolicyError, type PwnedRangeFetch } from "@/lib/auth/passwordPolicy";

export const AUTH_SCHEMA = "polynovea_auth";
export { MAX_PASSWORD_LENGTH };
/** Cookie names start with this; with `__Host-` the browser refuses them without Secure, with a Domain, or off Path=/. */
export const COOKIE_PREFIX = "__Host-polynovea";
export const IDLE_TIMEOUT_SECONDS = 12 * 60 * 60;
export const ABSOLUTE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
/** Step-up window: sensitive actions need a sign-in within this many seconds. */
export const STEP_UP_SECONDS = 10 * 60;
/** Per-account sign-in throttle, on top of the per-IP limits: after 30 attempts, sign-in for that account pauses until 15 minutes pass with no attempt. */
export const ACCOUNT_SIGN_IN_LIMIT = { max: 30, windowSeconds: 15 * 60 };

/** Paths whose success creates a new session for the browser. */
const SESSION_CREATING_PATHS = new Set(["/sign-in/email", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/passkey/verify-authentication"]);

export interface PolynoveaAuthSettings {
  /** Kysely instance for the CMS database (getDb() in the app). */
  db: Kysely<DB>;
  /** At least 32 random bytes; POLYNOVEA_AUTH_SECRET in the environment. Never stored in the database. */
  secret: string;
  /** Public URL of the CMS, e.g. https://cms.example.com. Passkeys are bound to its origin. */
  baseURL: string;
  /**
   * Addresses or CIDR ranges of the reverse proxies in front of the app (POLYNOVEA_TRUSTED_PROXIES).
   * X-Forwarded-For is walked right to left past these; the first other address is the client.
   */
  trustedProxies?: string[];
  /** Rate limiting is on unless a test switches it off. */
  rateLimit?: boolean;
  /** Called after a user row is created (managed provisioning). */
  onUserCreated?: (user: { id: string; email: string | null }) => Promise<void>;
  /** Breached-password lookup; tests pass a stub. */
  pwnedLookup?: PwnedRangeFetch;
  /** Test-only extra plugins (regression tests drive internal flows through them). Never set in the app. */
  testPlugins?: BetterAuthPlugin[];
}

type HookUser = { id: string; email?: string | null; twoFactorEnabled?: boolean | null };

function accountThrottleKey(email: string): string {
  return `account:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}:/sign-in/email`;
}

export function createPolynoveaAuth(settings: PolynoveaAuthSettings) {
  if (settings.secret.length < 32) throw new Error("POLYNOVEA_AUTH_SECRET must be at least 32 characters");
  const origin = new URL(settings.baseURL).origin;
  const rpID = new URL(settings.baseURL).hostname;

  /** Does this user have a second factor? Then 8 characters are enough. */
  const userHasMfa = async (adapter: { count: (q: { model: string; where: { field: string; value: string }[] }) => Promise<number> }, user: HookUser) =>
    Boolean(user.twoFactorEnabled) || (await adapter.count({ model: "passkey", where: [{ field: "userId", value: user.id }] })) > 0;

  return betterAuth({
    appName: "Polynovea CMS",
    baseURL: settings.baseURL,
    secret: settings.secret,
    trustedOrigins: [origin],
    database: { db: settings.db.withPlugin(new AuthDateColumnsPlugin()), type: "postgres", schemaName: AUTH_SCHEMA },
    emailAndPassword: {
      enabled: true,
      // No public sign-up: accounts are created by the setup wizard and by admins (createUser in provider.ts).
      disableSignUp: true,
      // The library checks the lowest length we ever accept; the 15-character single-factor rule and
      // the breached check run in the before hook and in provider.ts.
      minPasswordLength: MIN_PASSWORD_LENGTH_WITH_MFA,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: IDLE_TIMEOUT_SECONDS,
      // Extend the idle window at most every 15 minutes, so a busy session does not write on every request.
      updateAge: 15 * 60,
      // Better Auth's own sensitive endpoints (enable 2FA, add a passkey) need the same recent sign-in as our step-up.
      freshAge: STEP_UP_SECONDS,
      cookieCache: { enabled: false },
    },
    account: {
      // An external sign-in (Google, Microsoft, later) links to an existing account only when the
      // provider says the address is verified; no provider is trusted by name.
      accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false },
    },
    user: {
      additionalFields: {
        // Self-service profile data, the counterpart of GoTrue's user_metadata. Never used for authorization.
        metadata: { type: "json", required: false, input: false },
      },
    },
    rateLimit: {
      enabled: settings.rateLimit ?? true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/*": { window: 60, max: 10 },
        "/two-factor/*": { window: 60, max: 10 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      cookiePrefix: COOKIE_PREFIX,
      // The __Host- prefix is in the name already; never add __Secure- in front of it.
      useSecureCookies: false,
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for"],
        ipv6Subnet: 64,
        ...(settings.trustedProxies?.length ? { trustedProxies: settings.trustedProxies } : {}),
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            if (settings.onUserCreated) await settings.onUserCreated({ id: user.id, email: user.email ?? null });
          },
        },
      },
      session: {
        update: {
          // Absolute timeout: sliding the idle window never takes a session past 7 days from sign-in.
          before: async (session, ctx) => {
            const current = (ctx?.context as { session?: { session?: { createdAt?: Date | string } } } | undefined)?.session?.session;
            if (!current?.createdAt || !session.expiresAt) return;
            const cap = new Date(new Date(current.createdAt).getTime() + ABSOLUTE_TIMEOUT_SECONDS * 1000);
            if (new Date(session.expiresAt) > cap) return { data: { ...session, expiresAt: cap } };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Never remember a device past the second factor: MFA is required at every sign-in.
        if (ctx.path.startsWith("/two-factor/") && ctx.body && typeof ctx.body === "object" && "trustDevice" in ctx.body) {
          ctx.body.trustDevice = false;
        }

        if (ctx.path === "/sign-in/email" && typeof ctx.body?.email === "string") {
          // One atomic statement, so parallel attempts cannot all read a fresh window: the count
          // restarts only after a quiet window, and every attempt extends it.
          const now = Date.now();
          const cutoff = now - ACCOUNT_SIGN_IN_LIMIT.windowSeconds * 1000;
          const { rows } = await sql<{ count: number }>`
            insert into ${sql.table(`${AUTH_SCHEMA}.rateLimit`)} as r ("key", "count", "lastRequest")
            values (${accountThrottleKey(ctx.body.email)}, 1, ${now})
            on conflict ("key") do update
              set "count" = case when r."lastRequest" < ${cutoff} then 1 else r."count" + 1 end,
                  "lastRequest" = ${now}
            returning "count"`.execute(settings.db);
          if (Number(rows[0]?.count ?? 0) > ACCOUNT_SIGN_IN_LIMIT.max) {
            throw new APIError("TOO_MANY_REQUESTS", { message: "Too many sign-in attempts. Try again later." });
          }
        }

        // With a passkey registered and no authenticator app, the password alone is not a second
        // factor: such users sign in with the passkey. Checked only once the password is proven, so
        // the answer reveals nothing to someone without it.
        if (ctx.path === "/sign-in/email" && typeof ctx.body?.email === "string" && typeof ctx.body?.password === "string") {
          const found = await ctx.context.internalAdapter.findUserByEmail(ctx.body.email.trim().toLowerCase(), { includeAccounts: true });
          const user = found?.user as HookUser | undefined;
          const credential = found?.accounts.find((account) => account.providerId === "credential");
          if (user && !user.twoFactorEnabled && credential?.password) {
            const passkeys = await ctx.context.adapter.count({ model: "passkey", where: [{ field: "userId", value: user.id }] });
            if (passkeys > 0 && (await verifyPassword({ hash: credential.password, password: ctx.body.password }))) {
              throw new APIError("FORBIDDEN", { message: "Sign in with your passkey", code: "PASSKEY_REQUIRED" });
            }
          }
        }

        if ((ctx.path === "/change-password" || ctx.path === "/set-password") && typeof ctx.body?.newPassword === "string") {
          // Before hooks run ahead of the endpoint's own session middleware, so read the session here.
          const session = await getSessionFromCtx(ctx).catch(() => null);
          const user = session?.user as HookUser | undefined;
          try {
            await assertAcceptablePassword({
              password: ctx.body.newPassword,
              hasMfa: user ? await userHasMfa(ctx.context.adapter, user) : false,
              email: user?.email ?? null,
              lookup: settings.pwnedLookup,
            });
          } catch (error) {
            if (error instanceof PasswordPolicyError) throw new APIError("BAD_REQUEST", { message: error.message, code: error.code });
            throw error;
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = returned instanceof Error || (returned instanceof Response && !returned.ok);

        // Replace a GoTrue bcrypt hash (or an older Argon2 setting) once the password is proven.
        if (ctx.path === "/sign-in/email" && !failed && typeof ctx.body?.email === "string" && typeof ctx.body?.password === "string") {
          const found = await ctx.context.internalAdapter.findUserByEmail(ctx.body.email.trim().toLowerCase(), { includeAccounts: true });
          const credential = found?.accounts.find((account) => account.providerId === "credential");
          if (found && credential?.password && needsRehash(credential.password) && (await verifyPassword({ hash: credential.password, password: ctx.body.password }))) {
            await ctx.context.internalAdapter.updatePassword(found.user.id, await hashPassword(ctx.body.password));
          }
        }

        // A new session ends the one this browser had (session ID changes on login and on step-up).
        const created = ctx.context.newSession?.session;
        if (created && SESSION_CREATING_PATHS.has(ctx.path)) {
          const previous = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
          if (previous && previous !== created.token) await ctx.context.internalAdapter.deleteSession(previous);
        }
      }),
    },
    plugins: [
      twoFactor({
        issuer: "Polynovea CMS",
        backupCodeOptions: { amount: 10, length: 12, storeBackupCodes: "encrypted" },
        // Throttling, not a hard lockout: after 10 consecutive failures the second factor pauses for 15 minutes.
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
      }),
      passkey({
        rpID,
        rpName: "Polynovea CMS",
        origin,
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      }),
      admin({ defaultRole: "user", adminRoles: ["admin"], allowImpersonatingAdmins: false, impersonationSessionDuration: 15 * 60 }),
      ...(settings.testPlugins ?? []),
    ],
    telemetry: { enabled: false },
  });
}

export type PolynoveaAuth = ReturnType<typeof createPolynoveaAuth>;
