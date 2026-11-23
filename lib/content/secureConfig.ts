import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadKeyRing, purposeKeys, requireKeyRing } from "../setup/keyRing.ts";

/**
 * Secrets the CMS keeps in its own database (publication target settings, webhook signing secrets,
 * credentials in the encrypted PostgreSQL secret store), encrypted with AES-256-GCM.
 *
 *   pv2.<kid>.<base64(iv | tag | ciphertext)>   current: the key ring's `secure-config` key for <kid>
 *   <base64(iv | tag | ciphertext)>             legacy: CMS_CONFIG_ENCRYPTION_KEY, read for one release
 *
 * New values always use the ring's first key. `polynovea-cms keys reencrypt` rewrites legacy values
 * and values under older keys (lib/setup/reencrypt.ts).
 *
 * Imports are relative with extensions so scripts can load this file with Node's type stripping.
 */

type Env = Record<string, string | undefined>;
export const CIPHERTEXT_PREFIX = "pv2.";
const AAD = Buffer.from("polynovea-secure-config:v2");

function legacyKey(env: Env): Buffer {
  const value = env.CMS_CONFIG_ENCRYPTION_KEY;
  if (!value) throw new Error("This value was encrypted with CMS_CONFIG_ENCRYPTION_KEY, which is not set. Set it until `polynovea-cms keys reencrypt` has run.");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32) throw new Error("CMS_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return buffer;
}

/** Key ID of a current ciphertext, or null for a legacy one. */
export function ciphertextKid(value: string): string | null {
  if (!value.startsWith(CIPHERTEXT_PREFIX)) return null;
  const dot = value.indexOf(".", CIPHERTEXT_PREFIX.length);
  return dot > CIPHERTEXT_PREFIX.length ? value.slice(CIPHERTEXT_PREFIX.length, dot) : null;
}

/** True when encryption is possible: a master key ring, or the legacy key. Used by the System Doctor checks. */
export function secureConfigKeyAvailable(env: Env = process.env): boolean {
  try {
    if (loadKeyRing(env)) return true;
  } catch {
    return false;
  }
  try {
    legacyKey(env);
    return true;
  } catch {
    return false;
  }
}

let warnedLegacyWrite = false;

export function encryptConfig(value: unknown, env: Env = process.env): string {
  const ring = loadKeyRing(env);
  if (!ring && env.CMS_CONFIG_ENCRYPTION_KEY) {
    // An install that has not booted with a key ring yet (the first boot creates one). Keep writing
    // the legacy format rather than fail; reencrypt moves these values later.
    if (!warnedLegacyWrite) console.warn("[secure-config] no master key ring yet: encrypting with the legacy CMS_CONFIG_ENCRYPTION_KEY");
    warnedLegacyWrite = true;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", legacyKey(env), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  const { primary } = purposeKeys(ring ?? requireKeyRing(env), "secure-config");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${CIPHERTEXT_PREFIX}${primary.kid}.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}

function open(key: Buffer, packed: Buffer, aad: Buffer | null): string {
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12), { authTagLength: 16 });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

export function decryptConfig<T>(value: string, env: Env = process.env): T {
  if (!value.startsWith(CIPHERTEXT_PREFIX)) return JSON.parse(open(legacyKey(env), Buffer.from(value, "base64"), null)) as T;
  const kid = ciphertextKid(value);
  if (!kid) throw new Error("Encrypted value is malformed");
  const key = purposeKeys(requireKeyRing(env), "secure-config").byKid(kid);
  if (!key) throw new Error(`Encrypted value uses master key ${kid}, which is not in the key ring`);
  return JSON.parse(open(key, Buffer.from(value.slice(CIPHERTEXT_PREFIX.length + kid.length + 1), "base64"), AAD)) as T;
}
