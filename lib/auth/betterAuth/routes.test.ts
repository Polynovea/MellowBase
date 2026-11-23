import { describe, expect, it } from "vitest";
import { isExposedAuthRequest } from "@/lib/auth/betterAuth/routes";

const req = (method: string, path: string) => new Request(`https://cms.example.test${path}`, { method });

describe("exposed auth endpoints", () => {
  it("lets the admin UI's endpoints through with their methods", () => {
    expect(isExposedAuthRequest(req("POST", "/api/auth/sign-in/email"))).toBe(true);
    expect(isExposedAuthRequest(req("GET", "/api/auth/get-session"))).toBe(true);
    expect(isExposedAuthRequest(req("POST", "/api/auth/passkey/verify-authentication"))).toBe(true);
  });

  it("hides sign-up, social sign-in, the admin plugin, account deletion and wrong methods", () => {
    for (const path of ["/sign-up/email", "/sign-in/social", "/admin/set-role", "/admin/impersonate-user", "/delete-user", "/update-user", "/request-password-reset", "/sign-in/email/../../admin/list-users"]) {
      expect(isExposedAuthRequest(req("POST", `/api/auth${path}`))).toBe(false);
    }
    expect(isExposedAuthRequest(req("GET", "/api/auth/sign-in/email"))).toBe(false);
    expect(isExposedAuthRequest(req("POST", "/api/other/sign-in/email"))).toBe(false);
  });
});
