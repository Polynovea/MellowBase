import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertAcceptablePassword, passwordLength, resetBreachedListForTests } from "@/lib/auth/passwordPolicy";

const offline = async () => null;
const check = (password: string, hasMfa = false, email: string | null = "editor@example.test") =>
  assertAcceptablePassword({ password, hasMfa, email, lookup: offline });

afterEach(() => {
  delete process.env.POLYNOVEA_BREACHED_PASSWORDS_FILE;
  resetBreachedListForTests();
});

describe("password policy", () => {
  it("needs 15 characters without MFA and 8 with it, up to 128, counted in code points", async () => {
    await expect(check("fourteen chars")).rejects.toThrow(/at least 15/);
    await expect(check("fifteen chars!!")).resolves.toBeUndefined();
    await expect(check("seven c", true)).rejects.toThrow(/at least 8/);
    await expect(check("eight ch", true)).resolves.toBeUndefined();
    await expect(check("x".repeat(129).replace(/x/g, (_, i) => String(i % 10)))).rejects.toThrow(/at most 128/);
    expect(passwordLength("🙂🙂")).toBe(2);
    // No composition rules: a long lower-case passphrase is fine.
    await expect(check("purple monkey dishwasher rides")).resolves.toBeUndefined();
  });

  it("refuses bundled common passwords, the account's own email, repeats and the product name", async () => {
    await expect(check("Password12345678")).rejects.toThrow(/too common/);
    await expect(check("qwertyuiop", true)).rejects.toThrow(/too common/);
    await expect(check("editor@example.test")).rejects.toThrow(/too common/);
    await expect(check("aaaaaaaaaaaaaaaa")).rejects.toThrow(/too common/);
    await expect(check("my polynovea password")).rejects.toThrow(/too common/);
  });

  it("adds an operator-supplied list", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pw-"));
    const file = path.join(dir, "list.txt");
    writeFileSync(file, "a perfectly normal phrase\r\nanother one here please\n");
    process.env.POLYNOVEA_BREACHED_PASSWORDS_FILE = file;
    resetBreachedListForTests();
    await expect(check("A Perfectly Normal Phrase")).rejects.toThrow(/too common/);
  });

  it("checks the range API with only a 5-character hash prefix, and tolerates it being offline", async () => {
    const pass = "a phrase that leaked somewhere";
    const digest = createHash("sha1").update(pass).digest("hex").toUpperCase();
    const asked: string[] = [];
    const lookup = async (prefix: string) => {
      asked.push(prefix);
      return `0000000000000000000000000000000000A:3\r\n${digest.slice(5)}:42\r\n`;
    };
    await expect(assertAcceptablePassword({ password: pass, hasMfa: false, lookup })).rejects.toThrow(/breach/);
    expect(asked).toEqual([digest.slice(0, 5)]);
    // Padding entries have a zero count and never match.
    await expect(assertAcceptablePassword({ password: pass, hasMfa: false, lookup: async () => `${digest.slice(5)}:0` })).resolves.toBeUndefined();
    await expect(assertAcceptablePassword({ password: pass, hasMfa: false, lookup: offline })).resolves.toBeUndefined();
  });
});
