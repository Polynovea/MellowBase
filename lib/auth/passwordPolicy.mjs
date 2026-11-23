/**
 * Password rules for the built-in auth (NIST SP 800-63B-4):
 *
 * - at least 15 characters when the password is the account's only factor, 8 once it has MFA;
 * - up to 128 characters, any Unicode, no composition rules, no forced rotation;
 * - never a known-breached password: a bundled list of common passwords (always), plus the Have I
 *   Been Pwned range API (k-anonymity: only the first 5 characters of the SHA-1 leave the server)
 *   through guardedFetch when the install can reach the internet;
 * - never the account's own email or its local part, or the product name.
 *
 * Messages are written for the person choosing the password and never reveal anything about other
 * accounts.
 *
 * Plain JavaScript (with passwordPolicy.d.mts), so server scripts such as bootstrap-admin apply the
 * very same rules as the app without a build step.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { COMMON_PASSWORDS } from "./commonPasswords.mjs";

export const MIN_PASSWORD_LENGTH_SINGLE_FACTOR = 15;
export const MIN_PASSWORD_LENGTH_WITH_MFA = 8;
export const MAX_PASSWORD_LENGTH = 128;

export class PasswordPolicyError extends Error {
  code = "PASSWORD_POLICY";
}

/** Length is counted in Unicode code points, after the NFKC normalisation the hasher also applies. */
export function passwordLength(password) {
  return [...password.normalize("NFKC")].length;
}

/** @type {Set<string> | null} */
let extraList = null;
/**
 * The bundled list, plus an optional larger list the operator supplies (one password per line) in
 * POLYNOVEA_BREACHED_PASSWORDS_FILE. Compared case-insensitively.
 */
function breachedList() {
  if (extraList) return extraList;
  const list = new Set(COMMON_PASSWORDS.map((value) => value.toLowerCase()));
  const file = process.env.POLYNOVEA_BREACHED_PASSWORDS_FILE;
  if (file) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const value = line.trim().toLowerCase();
      if (value) list.add(value);
    }
  }
  extraList = list;
  return list;
}

/** Test hook. */
export function resetBreachedListForTests() {
  extraList = null;
}


/** Have I Been Pwned range lookup through guardedFetch. Null when the service cannot be reached. */
export const fetchPwnedRange = async (prefix) => {
  if (process.env.POLYNOVEA_HIBP_DISABLED === "true") return null;
  try {
    const { guardedFetch } = await import("../infrastructure/guardedNetwork.mjs");
    const response = await guardedFetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "polynovea-cms" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    // Offline installs still get the bundled list; the API is an extra check, not a dependency.
    return null;
  }
};

async function isPwned(password, lookup) {
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const body = await lookup(digest.slice(0, 5));
  if (!body) return false;
  const suffix = digest.slice(5);
  for (const line of body.split(/\r?\n/)) {
    const [candidate, count] = line.trim().split(":");
    if (candidate === suffix && Number(count) > 0) return true;
  }
  return false;
}

/** Throws PasswordPolicyError with a message for the user when the password is not acceptable. */
export async function assertAcceptablePassword({ password, hasMfa, email, lookup = fetchPwnedRange }) {
  if (typeof password !== "string") throw new PasswordPolicyError("Enter a password");
  const min = hasMfa ? MIN_PASSWORD_LENGTH_WITH_MFA : MIN_PASSWORD_LENGTH_SINGLE_FACTOR;
  const length = passwordLength(password);
  if (length < min) {
    throw new PasswordPolicyError(
      hasMfa
        ? `Use at least ${min} characters`
        : `Use at least ${min} characters (or ${MIN_PASSWORD_LENGTH_WITH_MFA} once you add an authenticator app or passkey)`,
    );
  }
  if (length > MAX_PASSWORD_LENGTH) throw new PasswordPolicyError(`Use at most ${MAX_PASSWORD_LENGTH} characters`);

  const lowered = password.normalize("NFKC").toLowerCase();
  const compact = lowered.replace(/\s+/g, "");
  const local = email?.split("@")[0]?.toLowerCase();
  if (
    breachedList().has(lowered) ||
    breachedList().has(compact) ||
    (email && lowered === email.toLowerCase()) ||
    (local && local.length >= 4 && compact === local) ||
    /^(.)\1+$/u.test(compact) ||
    compact.includes("polynovea")
  ) {
    throw new PasswordPolicyError("That password is too common or easy to guess. Choose another");
  }
  if (await isPwned(password, lookup)) {
    throw new PasswordPolicyError("That password has appeared in a data breach. Choose another");
  }
}
