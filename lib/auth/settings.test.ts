import { afterEach, describe, expect, it } from "vitest";
import { createRateLimitKey, getIP } from "@better-auth/core/utils/ip";
import { clientAddressOptions } from "@/lib/auth/betterAuth/server";
import { assertAuthSettings, clientAddressMode, parseAuthProvider } from "@/lib/auth/settings";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("AUTH_PROVIDER", () => {
  it("defaults to supabase and accepts builtin", () => {
    expect(parseAuthProvider(undefined)).toBe("supabase");
    expect(parseAuthProvider(" ")).toBe("supabase");
    expect(parseAuthProvider("BuiltIn")).toBe("builtin");
  });

  it("refuses an unknown provider instead of guessing", () => {
    expect(() => parseAuthProvider("gotrue")).toThrow(/AUTH_PROVIDER/);
  });

  it("refuses a server and browser mismatch, and builtin without its secret and URL", () => {
    process.env.AUTH_PROVIDER = "builtin";
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "supabase";
    expect(() => assertAuthSettings()).toThrow(/must match/);
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "builtin";
    process.env.POLYNOVEA_AUTH_SECRET = "short";
    expect(() => assertAuthSettings()).toThrow(/POLYNOVEA_AUTH_SECRET/);
    process.env.POLYNOVEA_AUTH_SECRET = "x".repeat(32);
    delete process.env.POLYNOVEA_PUBLIC_URL;
    expect(() => assertAuthSettings()).toThrow(/POLYNOVEA_PUBLIC_URL/);
    process.env.POLYNOVEA_PUBLIC_URL = "https://cms.example.test";
    expect(() => assertAuthSettings()).not.toThrow();
  });
});

describe("built-in auth without a proxy list: only the SSH-tunnel route", () => {
  const builtin = (env: Record<string, string | undefined>) => {
    process.env = { ...saved, AUTH_PROVIDER: "builtin", NEXT_PUBLIC_AUTH_PROVIDER: "builtin", POLYNOVEA_AUTH_SECRET: "x".repeat(32), NODE_ENV: "production", ...env };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  };

  it("tunnel: loopback bind + http://localhost (or 127.0.0.1, [::1]) + no proxies starts, in tunnel mode", () => {
    for (const [host, url] of [["127.0.0.1", "http://localhost:3000"], ["::1", "http://127.0.0.1:3000"], ["127.0.0.1", "http://[::1]:8080"]]) {
      builtin({ HOSTNAME: host, POLYNOVEA_PUBLIC_URL: url, POLYNOVEA_TRUSTED_PROXIES: undefined });
      expect(assertAuthSettings()).toBe("tunnel");
      expect(clientAddressMode(process.env)).toBe("tunnel");
    }
  });

  it("the Caddy/domain route binds to loopback too, but its https address still needs the proxy list", () => {
    builtin({ HOSTNAME: "127.0.0.1", POLYNOVEA_PUBLIC_URL: "https://cms.example.com", POLYNOVEA_TRUSTED_PROXIES: undefined });
    expect(() => assertAuthSettings()).toThrow(/POLYNOVEA_TRUSTED_PROXIES must list/);
    // https on localhost is a proxy too (Caddy for "localhost"), not a tunnel.
    builtin({ HOSTNAME: "127.0.0.1", POLYNOVEA_PUBLIC_URL: "https://localhost", POLYNOVEA_TRUSTED_PROXIES: undefined });
    expect(() => assertAuthSettings()).toThrow(/POLYNOVEA_TRUSTED_PROXIES must list/);
  });

  it("a loopback address on a server that listens everywhere (or on an unset HOSTNAME) still needs the list", () => {
    for (const host of [undefined, "", "0.0.0.0", "::", "10.0.0.5"]) {
      builtin({ HOSTNAME: host, POLYNOVEA_PUBLIC_URL: "http://localhost:3000", POLYNOVEA_TRUSTED_PROXIES: undefined });
      expect(() => assertAuthSettings()).toThrow(/POLYNOVEA_TRUSTED_PROXIES must list/);
    }
  });

  it("proxy and domain routes are unchanged: with the list they start, in proxied mode", () => {
    builtin({ HOSTNAME: "127.0.0.1", POLYNOVEA_PUBLIC_URL: "https://cms.example.com", POLYNOVEA_TRUSTED_PROXIES: "127.0.0.1" });
    expect(assertAuthSettings()).toBe("proxied");
    // A proxy list always means proxied, even on a loopback http address.
    builtin({ HOSTNAME: "127.0.0.1", POLYNOVEA_PUBLIC_URL: "http://localhost:3000", POLYNOVEA_TRUSTED_PROXIES: "127.0.0.1" });
    expect(assertAuthSettings()).toBe("proxied");
  });

  it("another provider has no client-address mode", () => {
    process.env = { ...saved, AUTH_PROVIDER: "supabase", NEXT_PUBLIC_AUTH_PROVIDER: "supabase" };
    expect(assertAuthSettings()).toBeNull();
  });
});

describe("tunnel mode: a forged X-Forwarded-For never picks the rate-limit bucket", () => {
  const ipFor = (mode: "tunnel" | "proxied", forwardedFor: string) =>
    getIP(new Request("http://localhost:3000/api/auth/sign-in/email", { headers: { "x-forwarded-for": forwardedFor } }),
      { advanced: { ipAddress: clientAddressOptions({ clientAddressMode: mode, trustedProxies: mode === "proxied" ? ["127.0.0.1"] : [] }) } } as never);

  it("tunnel: no client header is read, so every forged value lands in the same bucket", () => {
    expect(clientAddressOptions({ clientAddressMode: "tunnel" }).ipAddressHeaders).toEqual([]);
    expect(ipFor("tunnel", "203.0.113.7")).toBe(ipFor("tunnel", "198.51.100.9"));
    expect(ipFor("tunnel", "203.0.113.7")).not.toBe("203.0.113.7");
    expect(createRateLimitKey(ipFor("tunnel", "203.0.113.7") ?? "", "/sign-in/email")).toBe(createRateLimitKey(ipFor("tunnel", "1.1.1.1") ?? "", "/sign-in/email"));
  });

  it("proxied (unchanged): the client address behind the trusted proxy is used", () => {
    expect(ipFor("proxied", "203.0.113.7, 127.0.0.1")).toBe("203.0.113.7");
    expect(ipFor("proxied", "198.51.100.9, 127.0.0.1")).toBe("198.51.100.9");
  });
});
