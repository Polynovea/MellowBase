/**
 * Secrets the CMS keeps in its own database, encrypted under the master key ring (ADR-006):
 * `pv2.<kid>.` ciphertext, with legacy CMS_CONFIG_ENCRYPTION_KEY values still read for one release.
 *
 * Implementation lives in lib/setup/configCipher.mjs so the plain-Node delivery worker and the
 * certification scripts use exactly the same code.
 */
export { CIPHERTEXT_PREFIX, ciphertextKid, decryptConfig, encryptConfig, secureConfigKeyAvailable } from "../setup/configCipher.mjs";
