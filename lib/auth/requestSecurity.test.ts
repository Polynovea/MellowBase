import { describe, expect, it } from "vitest";
import type { RequestIdentity } from "@/lib/auth/provider";
import { CSRF_HEADER, csrfProblem, csrfToken, needsStepUp, requiredAuthenticators } from "@/lib/auth/requestSecurity";

const settings = { publicOrigin: "https://cms.example.test", secret: "s".repeat(40) };
const identity = (over: Partial<RequestIdentity> = {}): RequestIdentity => ({
  user: { id: "u1", email: "a@example.test", emailConfirmedAt: null, metadata: {} },
  sessionId: "session-1",
  authenticatedAt: new Date(),
  transport: "cookie",
  authenticators: 1,
  ...over,
});
const req = (method: string, headers: Record<string, string>) => new Request("https://cms.example.test/api/x", { method, headers });
const good = { origin: settings.publicOrigin, "sec-fetch-site": "same-origin", [CSRF_HEADER]: csrfToken("session-1", settings.secret) };

describe("CSRF for cookie credentials", () => {
  it("lets safe methods and bearer credentials through untouched", () => {
    expect(csrfProblem(req("GET", {}), identity(), settings)).toBeNull();
    expect(csrfProblem(req("POST", {}), identity({ transport: "bearer" }), settings)).toBeNull();
  });

  it("needs the CMS origin, a same-origin fetch and the session's token on state changes", () => {
    expect(csrfProblem(req("POST", good), identity(), settings)).toBeNull();
    expect(csrfProblem(req("DELETE", { ...good, origin: "https://evil.example" }), identity(), settings)).toMatch(/origin/);
    expect(csrfProblem(req("PATCH", { ...good, "sec-fetch-site": "cross-site" }), identity(), settings)).toMatch(/cross-site/);
    expect(csrfProblem(req("POST", { ...good, "sec-fetch-site": "same-site" }), identity(), settings)).toMatch(/cross-site/);
    const { [CSRF_HEADER]: _token, ...noToken } = good;
    expect(csrfProblem(req("POST", noToken), identity(), settings)).toMatch(/token/);
    // A token from another session is worthless.
    expect(csrfProblem(req("POST", { ...good, [CSRF_HEADER]: csrfToken("session-2", settings.secret) }), identity(), settings)).toMatch(/token/);
    // No Origin at all: the Referer must still be the CMS.
    const { origin: _origin, ...noOrigin } = good;
    expect(csrfProblem(req("POST", { ...noOrigin, referer: "https://cms.example.test/admin" }), identity(), settings)).toBeNull();
    expect(csrfProblem(req("POST", noOrigin), identity(), settings)).toMatch(/origin/);
  });
});

describe("step-up and MFA rules", () => {
  it("needs a sign-in within 10 minutes, and fails closed without a time", () => {
    expect(needsStepUp(identity({ authenticatedAt: new Date(Date.now() - 9 * 60_000) }))).toBe(false);
    expect(needsStepUp(identity({ authenticatedAt: new Date(Date.now() - 11 * 60_000) }))).toBe(true);
    expect(needsStepUp(identity({ authenticatedAt: null }))).toBe(true);
  });

  it("owners need two authenticators, admins one, others none", () => {
    expect(requiredAuthenticators("master")).toBe(2);
    expect(requiredAuthenticators("admin")).toBe(1);
    expect(requiredAuthenticators("editor")).toBe(0);
  });
});
