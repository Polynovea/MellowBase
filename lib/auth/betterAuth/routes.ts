/**
 * The Better Auth endpoints the CMS exposes under /api/auth, and nothing else.
 *
 * The library ships many endpoints (sign-up, social sign-in, account deletion, the admin plugin's
 * user management, impersonation...). Only the ones the admin UI uses are reachable from the
 * network; the rest stay callable from server code (auth.api.*) where our own authorization runs
 * first. Anything not listed gets a 404 before the library sees it.
 */
export const EXPOSED_AUTH_ENDPOINTS: Readonly<Record<string, readonly ("GET" | "POST")[]>> = {
  "/get-session": ["GET"],
  "/sign-in/email": ["POST"],
  "/sign-out": ["POST"],
  "/change-password": ["POST"],
  "/list-sessions": ["GET"],
  "/revoke-session": ["POST"],
  "/revoke-sessions": ["POST"],
  "/revoke-other-sessions": ["POST"],
  "/two-factor/enable": ["POST"],
  "/two-factor/disable": ["POST"],
  "/two-factor/get-totp-uri": ["POST"],
  "/two-factor/verify-totp": ["POST"],
  "/two-factor/verify-backup-code": ["POST"],
  "/two-factor/generate-backup-codes": ["POST"],
  "/passkey/generate-register-options": ["GET"],
  "/passkey/verify-registration": ["POST"],
  "/passkey/generate-authenticate-options": ["GET"],
  "/passkey/verify-authentication": ["POST"],
  "/passkey/list-user-passkeys": ["GET"],
  "/passkey/delete-passkey": ["POST"],
  "/passkey/update-passkey": ["POST"],
};

export const AUTH_BASE_PATH = "/api/auth";

/** True when the request is for an endpoint the CMS exposes. */
export function isExposedAuthRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const endpoint = pathname.slice(AUTH_BASE_PATH.length);
  const methods = EXPOSED_AUTH_ENDPOINTS[endpoint];
  return Boolean(methods?.includes(request.method as "GET" | "POST"));
}
