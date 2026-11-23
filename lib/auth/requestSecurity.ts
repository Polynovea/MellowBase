/**
 * Request checks that sit on top of a verified identity, for every provider:
 *
 * - CSRF, for credentials the browser attaches by itself (the built-in auth's session cookie). A
 *   state-changing request must come from the CMS's own origin (Origin, or Referer when a browser
 *   leaves Origin out; Sec-Fetch-Site when sent) and carry `x-polynovea-csrf`, a token bound to the
 *   session (HMAC of the session ID under the auth secret, from GET /api/auth/csrf). SameSite=Lax on
 *   the cookie is a third layer, not the only one. Bearer credentials are never sent by a browser on
 *   its own, so they need none of this.
 * - Step-up: sensitive actions need a sign-in within the last 10 minutes (design doc, OWASP Session
 *   Management): API token creation, role changes, sign-in and email settings, exports.
 * - MFA: owners need two authenticators and admins one before the CMS lets them do anything else
 *   (design doc, NIST SP 800-63B-4). Applies to the built-in auth; GoTrue keeps its own rules.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestIdentity } from "@/lib/auth/provider";

export const CSRF_HEADER = "x-polynovea-csrf";
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type SecurityCode = "CSRF_FAILED" | "STEP_UP_REQUIRED" | "MFA_REQUIRED";

export function csrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`).digest("base64url");
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") return origin;
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/** Null when the request passes; otherwise why it failed (for the log, never for the response). */
export function csrfProblem(request: Request, identity: RequestIdentity, settings: { publicOrigin: string; secret: string }): string | null {
  if (identity.transport !== "cookie" || SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return "cross-site request";
  if (requestOrigin(request) !== settings.publicOrigin) return "origin mismatch";
  const token = request.headers.get(CSRF_HEADER);
  if (!token || !identity.sessionId || !sameToken(token, csrfToken(identity.sessionId, settings.secret))) return "missing or wrong token";
  return null;
}

export function needsStepUp(identity: RequestIdentity, now = Date.now()): boolean {
  if (!identity.authenticatedAt) return true;
  return now - identity.authenticatedAt.getTime() > STEP_UP_MAX_AGE_MS;
}

/** Authenticators a role must have registered (TOTP app and passkeys count one each). */
export function requiredAuthenticators(role: string): number {
  if (role === "master") return 2;
  if (role === "admin") return 1;
  return 0;
}

export function securityResponse(code: SecurityCode): Response {
  const messages: Record<SecurityCode, [number, string]> = {
    CSRF_FAILED: [403, "This request did not come from the CMS. Reload the page and try again."],
    STEP_UP_REQUIRED: [403, "Confirm it's you to continue."],
    MFA_REQUIRED: [403, "Set up two-step sign-in to continue."],
  };
  const [status, error] = messages[code];
  return Response.json({ success: false, data: null, error, code, timestamp: new Date().toISOString() }, { status });
}
