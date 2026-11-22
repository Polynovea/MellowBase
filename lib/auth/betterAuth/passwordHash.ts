import { randomBytes, timingSafeEqual } from "node:crypto";
import * as nodeCrypto from "node:crypto";

/**
 * Argon2id password hashing for the built-in auth (OWASP minimum: 19 MiB, 2 iterations, 1 lane).
 *
 * Uses Node's own crypto.argon2 (Node 24.7+), so there is no native add-on to build. Hashes are
 * stored as standard PHC strings, so other Argon2 libraries can verify them.
 * TODO(phase 1): also verify the bcrypt hashes GoTrue stored, and rehash them on the next sign-in.
 */

const PARAMS = { memory: 19 * 1024, passes: 2, parallelism: 1, tagLength: 32 } as const;

type Argon2Fn = (
  algorithm: "argon2id",
  parameters: { message: string | Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  callback: (error: Error | null, derivedKey: Buffer) => void,
) => void;

function argon2(): Argon2Fn {
  const fn = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;
  if (!fn) throw new Error("Built-in auth needs Node.js 24.7 or later (crypto.argon2)");
  return fn;
}

function derive(password: string, nonce: Buffer, params: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2()("argon2id", { message: password.normalize("NFKC"), nonce, ...params }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const b64 = (value: Buffer) => value.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(key)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const match = PHC.exec(hash);
  if (!match) return false;
  const [, m, t, p, salt, expected] = match;
  const expectedKey = Buffer.from(expected, "base64");
  const memory = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  // Refuse parameters far outside what we issue, so a tampered hash cannot pin the CPU.
  if (memory > 256 * 1024 || passes > 10 || parallelism > 4 || expectedKey.length < 16 || expectedKey.length > 64) return false;
  const key = await derive(password, Buffer.from(salt, "base64"), { memory, passes, parallelism, tagLength: expectedKey.length });
  return timingSafeEqual(key, expectedKey);
}
