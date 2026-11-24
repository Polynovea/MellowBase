import { describe, expect, it } from "vitest";
import { scriptAuthProvider, signInBuiltin, signInToCms } from "./cmsSession.mjs";

type Call = { url: string; init: RequestInit };

/** A fake CMS: built-in auth endpoints, a CSRF endpoint and one API route. */
function fakeCms({ mfa = false, csrfStatus = 200 }: { mfa?: boolean; csrfStatus?: number } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200, cookies: string[] = []) => {
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === "/api/auth/sign-in/email") {
      return mfa
        ? json({ twoFactorRedirect: true }, 200, ["__Host-polynovea.two_factor=challenge; Path=/; HttpOnly"])
        : json({ token: "t" }, 200, ["__Host-polynovea.session_token=s1; Path=/; HttpOnly"]);
    }
    if (path === "/api/auth/two-factor/verify-totp" || path === "/api/auth/two-factor/verify-backup-code") {
      const body = JSON.parse(String(init.body));
      if (body.code === "000000") return json({ code: "INVALID_CODE", message: "Invalid code" }, 401);
      return json({ token: "t" }, 200, ["__Host-polynovea.two_factor=; Path=/; Max-Age=0", "__Host-polynovea.session_token=s2; Path=/; HttpOnly"]);
    }
    if (path === "/api/auth/csrf") return csrfStatus === 200 ? json({ data: { token: "csrf-1" } }) : json({ error: "Not found" }, csrfStatus);
    if (path === "/api/models") return init.method === "POST" ? json({ error: "Name taken" }, 409) : json({ success: true, data: [{ id: "m1" }] });
    return json({ error: "Not found" }, 404);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const base = { baseUrl: "http://localhost:3000", email: "owner@example.test", password: "a long enough passphrase" };

describe("seed:starter sign-in", () => {
  it("follows AUTH_PROVIDER exactly like the app does", () => {
    expect(scriptAuthProvider(undefined)).toBe("supabase");
    expect(scriptAuthProvider(" BuiltIn ")).toBe("builtin");
    expect(() => scriptAuthProvider("gotrue")).toThrow(/AUTH_PROVIDER/);
  });

  it("signs in on the built-in auth and calls the API with cookie, origin and CSRF token", async () => {
    const cms = fakeCms();
    const session = await signInBuiltin({ ...base, fetchImpl: cms.fetchImpl });
    expect(await session.request("/api/models")).toEqual([{ id: "m1" }]);
    const api = cms.calls.at(-1)!;
    expect(api.init.headers).toMatchObject({ cookie: "__Host-polynovea.session_token=s1", origin: "http://localhost:3000", "x-polynovea-csrf": "csrf-1" });
    expect(cms.calls[0].init.headers).toMatchObject({ origin: "http://localhost:3000" });
  });

  it("asks for the one-time code when the account has a second factor", async () => {
    const cms = fakeCms({ mfa: true });
    await expect(signInBuiltin({ ...base, fetchImpl: cms.fetchImpl })).rejects.toThrow(/POLYNOVEA_OWNER_OTP/);
  });

  it("uses a 6-digit code as an authenticator code and anything else as a recovery code", async () => {
    const totp = fakeCms({ mfa: true });
    const session = await signInBuiltin({ ...base, code: "123456", fetchImpl: totp.fetchImpl });
    expect(totp.calls.map((c) => new URL(c.url).pathname)).toContain("/api/auth/two-factor/verify-totp");
    await session.request("/api/models");
    // The challenge cookie is gone; only the new session cookie is sent.
    expect(totp.calls.at(-1)!.init.headers).toMatchObject({ cookie: "__Host-polynovea.session_token=s2" });

    const recovery = fakeCms({ mfa: true });
    await signInBuiltin({ ...base, code: "abcd-efgh-ijkl", fetchImpl: recovery.fetchImpl });
    expect(recovery.calls.map((c) => new URL(c.url).pathname)).toContain("/api/auth/two-factor/verify-backup-code");
  });

  it("reports a wrong code and a missing CSRF endpoint in plain words", async () => {
    await expect(signInBuiltin({ ...base, code: "000000", fetchImpl: fakeCms({ mfa: true }).fetchImpl })).rejects.toThrow(/verify-totp failed: Invalid code/);
    await expect(signInBuiltin({ ...base, fetchImpl: fakeCms({ csrfStatus: 404 }).fetchImpl })).rejects.toThrow(/AUTH_PROVIDER=builtin/);
  });

  it("surfaces API errors from the CMS", async () => {
    const session = await signInBuiltin({ ...base, fetchImpl: fakeCms().fetchImpl });
    await expect(session.request("/api/models", { method: "POST", body: "{}" })).rejects.toThrow("Name taken");
  });

  it("on Supabase, refuses without the Supabase settings instead of half-working", async () => {
    await expect(signInToCms({ provider: "supabase", ...base, log: () => undefined })).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("security review: where credentials may go", async () => {
  const { checkCmsTarget, signInToCms: signIn } = await import("./cmsSession.mjs");

  it("refuses plain http to any host but this machine; https anywhere", () => {
    expect(checkCmsTarget("https://cms.example.com/")).toBe("https://cms.example.com");
    for (const local of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://cms.localhost"]) expect(() => checkCmsTarget(local)).not.toThrow();
    for (const remote of ["http://cms.example.com", "http://10.0.0.5:3000", "http://localhost.evil.com", "http://127.0.0.1.nip.io"]) {
      expect(() => checkCmsTarget(remote)).toThrow(/plain http/);
    }
    expect(() => checkCmsTarget("ftp://cms.example.com")).toThrow(/https/);
    expect(() => checkCmsTarget("not a url")).toThrow(/valid URL/);
  });

  it("announces the target before sending anything, and sends nothing to a refused target", async () => {
    const lines: string[] = [];
    const cms = fakeCms();
    await signIn({ provider: "builtin", ...base, fetchImpl: cms.fetchImpl, log: (line: string) => lines.push(`${line}|calls=${cms.calls.length}`) });
    expect(lines).toEqual(["Signing in to http://localhost:3000 as owner@example.test|calls=0"]);
    const remote = fakeCms();
    await expect(signIn({ provider: "builtin", ...base, baseUrl: "http://cms.example.com", fetchImpl: remote.fetchImpl, log: () => undefined })).rejects.toThrow(/plain http/);
    expect(remote.calls).toHaveLength(0);
  });

  it("asks for the one-time code only when the account needs one", async () => {
    let asked = 0;
    const code = async () => { asked += 1; return "123456"; };
    await signInBuiltin({ ...base, code, fetchImpl: fakeCms().fetchImpl });
    expect(asked).toBe(0);
    await signInBuiltin({ ...base, code, fetchImpl: fakeCms({ mfa: true }).fetchImpl });
    expect(asked).toBe(1);
  });
});
