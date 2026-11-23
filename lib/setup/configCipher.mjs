import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadKeyRing, purposeKeys, requireKeyRing } from "./keyRing.mjs";

/**
 * Encryption for the secrets the CMS keeps in its own database (publication target settings,
 * webhook signing secrets, credentials in the encrypted PostgreSQL secret store). One implementation
 * for the app (lib/content/secureConfig.ts), the delivery worker and the certification scripts.
 *
 *   pv2.<kid>.<base64(iv | tag | ciphertext)>   current: the key ring's `secure-config` key for <kid>
 *   <base64(iv | tag | ciphertext)>             legacy: CMS_CONFIG_ENCRYPTION_KEY, read for one release
 *
 * AES-256-GCM; current values carry additional data "polynovea-secure-config:v2". New values use the
 * ring's first key. `polynovea-cms keys reencrypt` rewrites legacy values and values under older keys.
 */

/** @typedef {Record<string, string | undefined>} Env */

export const CIPHERTEXT_PREFIX = "pv2.";
const AAD = Buffer.from("polynovea-secure-config:v2");

/** @param {Env} env */
function legacyKey(env) {
  const value = env.CMS_CONFIG_ENCRYPTION_KEY;
  if (!value) throw new Error("This value was encrypted with CMS_CONFIG_ENCRYPTION_KEY, which is not set. Set it until `polynovea-cms keys reencrypt` has run.");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32) throw new Error("CMS_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return buffer;
}

/** Key ID of a current ciphertext, or null for a legacy one. @param {string} value */
export function ciphertextKid(value) {
  if (!value.startsWith(CIPHERTEXT_PREFIX)) return null;
  const dot = value.indexOf(".", CIPHERTEXT_PREFIX.length);
  return dot > CIPHERTEXT_PREFIX.length ? value.slice(CIPHERTEXT_PREFIX.length, dot) : null;
}

/** True when encryption is possible: a master key ring, or the legacy key. @param {Env} [env] */
export function secureConfigKeyAvailable(env = process.env) {
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

/** @param {Buffer} key @param {Buffer | null} aad @param {unknown} value */
function seal(key, aad, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** @param {Buffer} key @param {Buffer} packed @param {Buffer | null} aad */
function open(key, packed, aad) {
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12), { authTagLength: 16 });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * Always writes pv2.<kid>. values under the ring's first key. With only CMS_CONFIG_ENCRYPTION_KEY set,
 * that is the `legacy` ring entry (keyRing.mjs), shared by every process with the same environment.
 * @param {unknown} value @param {Env} [env] @returns {string}
 */
export function encryptConfig(value, env = process.env) {
  const { primary } = purposeKeys(requireKeyRing(env), "secure-config");
  return `${CIPHERTEXT_PREFIX}${primary.kid}.${seal(primary.key, AAD, value)}`;
}

/** @param {string} value @param {Env} [env] */
export function decryptConfig(value, env = process.env) {
  if (!value.startsWith(CIPHERTEXT_PREFIX)) return JSON.parse(open(legacyKey(env), Buffer.from(value, "base64"), null));
  const kid = ciphertextKid(value);
  if (!kid) throw new Error("Encrypted value is malformed");
  const key = purposeKeys(requireKeyRing(env), "secure-config").byKid(kid);
  if (!key) throw new Error(`Encrypted value uses master key ${kid}, which is not in the key ring`);
  return JSON.parse(open(key, Buffer.from(value.slice(CIPHERTEXT_PREFIX.length + kid.length + 1), "base64"), AAD));
}
