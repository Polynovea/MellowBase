import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { hashPassword, isBcryptHash, needsRehash, verifyPassword } from "@/lib/auth/betterAuth/passwordHash";

describe("password hashing", () => {
  it("hashes with Argon2id at 19 MiB, 2 iterations, 1 lane and verifies", async () => {
    const hash = await hashPassword("a long enough passphrase");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword({ hash, password: "a long enough passphrase" })).toBe(true);
    expect(await verifyPassword({ hash, password: "a long enough passphrasE" })).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it("verifies GoTrue bcrypt hashes and marks them for rehashing", async () => {
    const hash = await bcrypt.hash("gotrue password", 10);
    expect(isBcryptHash(hash)).toBe(true);
    expect(await verifyPassword({ hash, password: "gotrue password" })).toBe(true);
    expect(await verifyPassword({ hash, password: "gotrue passworD" })).toBe(false);
    expect(needsRehash(hash)).toBe(true);
  });

  it("refuses hashes that could pin the CPU or are malformed", async () => {
    expect(isBcryptHash("$2a$31$" + "a".repeat(53))).toBe(false);
    expect(await verifyPassword({ hash: "$argon2id$v=19$m=999999,t=2,p=1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5", password: "x" })).toBe(false);
    expect(await verifyPassword({ hash: "plain", password: "plain" })).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$a2V5")).toBe(true);
  });
});
