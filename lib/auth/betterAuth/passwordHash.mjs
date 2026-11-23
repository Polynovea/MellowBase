import { randomBytes, timingSafeEqual } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * Password hashing for the built-in auth.
 *
 * New hashes are Argon2id (OWASP minimum: 19 MiB, 2 iterations, 1 lane) through Node's own
 * crypto.argon2 (Node 24.7+), stored as standard PHC strings so other Argon2 libraries can verify them.
 *
 * Users moved from Supabase GoTrue keep their bcrypt hash (`$2a$`/`$2b$`/`$2y$`). verifyPassword
 * accepts it, and the sign-in hook in server.ts replaces it with Argon2id at the next successful
 * sign-in (needsRehash tells it when).
 */

// Plain JavaScript (with passwordHash.d.mts), so server scripts such as bootstrap-admin use the very
// same hasher as the app without a build step.

const PARAMS = Object.freeze({ memory: 19 * 1024, passes: 2, parallelism: 1, tagLength: 32 });

function argon2() {
  const fn = nodeCrypto.argon2;
  if (!fn) throw new Error("Built-in auth needs Node.js 24.7 or later (crypto.argon2)");
  return fn;
}

function derive(password, nonce, params) {
  return new Promise((resolve, reject) => {
    argon2()("argon2id", { message: password.normalize("NFKC"), nonce, ...params }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const b64 = (value) => value.toString("base64").replace(/=+$/, "");

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(key)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
// GoTrue writes bcrypt with cost 10; accept the usual cost range and nothing that could pin the CPU.
const BCRYPT = /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/;

export function isBcryptHash(hash) {
  return BCRYPT.test(hash);
}

/** True when a stored hash should be replaced with a fresh Argon2id hash after a successful sign-in. */
export function needsRehash(hash) {
  const match = PHC.exec(hash);
  if (!match) return true;
  return Number(match[1]) < PARAMS.memory || Number(match[2]) < PARAMS.passes;
}

export async function verifyPassword({ hash, password }) {
  if (typeof hash !== "string" || typeof password !== "string") return false;
  if (isBcryptHash(hash)) {
    // GoTrue hashed the raw password (no normalisation); bcrypt reads at most 72 bytes, as GoTrue did.
    return bcrypt.compare(password, hash);
  }
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
