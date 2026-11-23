export const MIN_PASSWORD_LENGTH_SINGLE_FACTOR: 15;
export const MIN_PASSWORD_LENGTH_WITH_MFA: 8;
export const MAX_PASSWORD_LENGTH: 128;

export class PasswordPolicyError extends Error {
  readonly code: "PASSWORD_POLICY";
}

/** Length in Unicode code points, after the NFKC normalisation the hasher also applies. */
export function passwordLength(password: string): number;
/** Test hook. */
export function resetBreachedListForTests(): void;

export type PwnedRangeFetch = (prefix: string) => Promise<string | null>;
/** Have I Been Pwned range lookup through guardedFetch. Null when the service cannot be reached. */
export const fetchPwnedRange: PwnedRangeFetch;

export interface PasswordCheckInput {
  password: string;
  /** True when the account has a second factor (TOTP or a passkey). */
  hasMfa: boolean;
  email?: string | null;
  lookup?: PwnedRangeFetch;
}

/** Throws PasswordPolicyError with a message for the user when the password is not acceptable. */
export function assertAcceptablePassword(input: PasswordCheckInput): Promise<void>;
