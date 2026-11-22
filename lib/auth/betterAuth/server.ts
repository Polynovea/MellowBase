/**
 * Better Auth, configured for the CMS (phase 0 spike; not wired into the app yet).
 *
 * - Its tables live in the polynovea_auth schema, through the same Kysely instance and pool as lib/db.
 * - Email and password plus the two-factor plugin (TOTP and recovery codes). Passkey and admin come in phase 1.
 * - User IDs are UUIDs, so admin_users.auth_user_id keeps working, and migrated GoTrue users keep theirs.
 * - Argon2id hashing, 15-character minimum (NIST 800-63B-4 for a password-only account), 128 maximum.
 * - Sessions only in the database: the cookie cache stays off (Better Auth's November 2026 advisory:
 *   revoked sessions stayed valid with it on). 7-day absolute lifetime.
 * - Telemetry off.
 */
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import { hashPassword, verifyPassword } from "@/lib/auth/betterAuth/passwordHash";

export const AUTH_SCHEMA = "polynovea_auth";
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 128;

export interface PolynoveaAuthSettings {
  /** Kysely instance for the CMS database (getDb() in the app). */
  db: Kysely<DB>;
  /** At least 32 random bytes; BETTER_AUTH_SECRET in the environment. Never stored in the database. */
  secret: string;
  /** Public URL of the CMS, e.g. https://cms.example.com */
  baseURL: string;
}

export function createPolynoveaAuth(settings: PolynoveaAuthSettings) {
  if (settings.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  return betterAuth({
    appName: "Polynovea CMS",
    baseURL: settings.baseURL,
    secret: settings.secret,
    database: { db: settings.db.withSchema(AUTH_SCHEMA), type: "postgres" },
    emailAndPassword: {
      enabled: true,
      // No public sign-up: accounts are created by the setup wizard and by admins (createUser in provider.ts).
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      autoSignIn: false,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        // Self-service profile data, the counterpart of GoTrue's user_metadata. Never used for authorization.
        metadata: { type: "json", required: false, input: false },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: settings.baseURL.startsWith("https://"),
    },
    plugins: [twoFactor({ issuer: "Polynovea CMS" })],
    telemetry: { enabled: false },
  });
}

export type PolynoveaAuth = ReturnType<typeof createPolynoveaAuth>;
