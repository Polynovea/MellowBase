import { afterEach, describe, expect, it } from "vitest";
import { assertAuthSettings, parseAuthProvider } from "@/lib/auth/settings";

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
