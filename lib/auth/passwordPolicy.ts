// The rules live in passwordPolicy.mjs so plain Node scripts apply them too.
export {
  assertAcceptablePassword,
  fetchPwnedRange,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH_SINGLE_FACTOR,
  MIN_PASSWORD_LENGTH_WITH_MFA,
  PasswordPolicyError,
  passwordLength,
  resetBreachedListForTests,
} from "./passwordPolicy.mjs";
export type { PasswordCheckInput, PwnedRangeFetch } from "./passwordPolicy.mjs";
