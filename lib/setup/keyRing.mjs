import { hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * The master key ring (ADR-006). One secret outside the database protects everything the CMS
 * encrypts: config.enc, the secrets stored in the database (secureConfig) and the signing key of
 * storage links. It is never used directly; each use gets its own key derived with HKDF-SHA256.
 *
 *   CMS_MASTER_KEY=kid1:base64,kid2:base64
 *
 * The first key encrypts and signs, every key decrypts and verifies, so a key is rotated by putting a
 * new one first, running `polynovea-cms keys reencrypt`, then removing the old one.
 *
 * Without CMS_MASTER_KEY the ring is read from <POLYNOVEA_CONFIG_DIR>/master.key (default
 * /var/lib/polynovea), which the first boot creates: 32 random bytes, file 0600 in a 0700 folder,
 * owned by the user the CMS runs as. The owner must keep a copy away from the database backups; a
 * backup and its key stored together protect nothing.
 *
 * Plain JavaScript (types in keyRing.d.mts) so the delivery worker and scripts share it with the app.
 */

/** @typedef {"config" | "secure-config" | "storage-signing"} KeyPurpose */
/** @typedef {{ kid: string, key: Buffer }} MasterKey */
/** @typedef {{ source: "env" | "file", keys: MasterKey[] }} KeyRing */
/** @typedef {Record<string, string | undefined>} Env */

export const DEFAULT_CONFIG_DIR = "/var/lib/polynovea";
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const HKDF_SALT = Buffer.from("polynovea-key-ring/v1");

export class KeyRingError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeyRingError";
  }
}

/** @param {Env} [env] */
export function configDir(env = process.env) {
  const dir = env.POLYNOVEA_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR;
  return path.resolve(dir);
}

/** @param {Env} [env] */
export function masterKeyPath(env = process.env) {
  return path.join(configDir(env), "master.key");
}

/** Parses `kid1:base64,kid2:base64`. Each key is exactly 32 bytes; key IDs are unique. */
/** @param {string} value @param {string} [name] @returns {MasterKey[]} */
export function parseMasterKeyRing(value, name = "CMS_MASTER_KEY") {
  /** @type {MasterKey[]} */
  const keys = [];
  for (const raw of value.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const colon = part.indexOf(":");
    if (colon <= 0) throw new KeyRingError(`${name} must be a list of kid:base64 entries`);
    const kid = part.slice(0, colon).trim();
    if (!KID_PATTERN.test(kid)) throw new KeyRingError(`${name} key IDs may use letters, digits, - and _ (up to 32)`);
    const encoded = part.slice(colon + 1).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new KeyRingError(`${name} key ${kid} must be base64 for exactly 32 bytes`);
    if (keys.some((existing) => existing.kid === kid)) throw new KeyRingError(`${name} lists key ${kid} twice`);
    keys.push({ kid, key });
  }
  if (!keys.length) throw new KeyRingError(`${name} is empty`);
  return keys;
}

/** @param {MasterKey[]} keys */
export function formatMasterKeyRing(keys) {
  return keys.map((entry) => `${entry.kid}:${entry.key.toString("base64")}`).join(",");
}

const isPosix = process.platform !== "win32";

/** On POSIX, refuses a secret file other users can read or that belongs to someone else (as ssh does). */
/** @param {string} file */
export function assertPrivateFile(file) {
  if (!isPosix) return;
  const stat = statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new KeyRingError(`${file} must be readable by its owner only (chmod 600)`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new KeyRingError(`${file} must belong to the user the CMS runs as`);
}

/** Creates the config folder (0700). Refuses to run as root: the files must belong to the service user. */
/** @param {Env} [env] */
export function ensureConfigDir(env = process.env) {
  const dir = configDir(env);
  if (isPosix && process.getuid?.() === 0) {
    throw new KeyRingError("Run the CMS as its own service user, not root: its key and configuration files must not belong to root");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isPosix) {
    const stat = statSync(dir);
    if ((stat.mode & 0o077) !== 0) throw new KeyRingError(`${dir} must be accessible by its owner only (chmod 700)`);
  }
  return dir;
}

function fsyncDir(dir) {
  if (!isPosix) return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function generatedKid(now = new Date()) {
  return `k${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

/**
 * Writes a new master.key. The file appears complete or not at all: it is written to a temporary
 * name and hard-linked into place, which fails if another process got there first (then its key wins).
 */
function createMasterKeyFile(env) {
  const dir = ensureConfigDir(env);
  const target = masterKeyPath(env);
  const temp = path.join(dir, `.master.key.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${formatMasterKeyRing([{ kid: generatedKid(), key: randomBytes(32) }])}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, target);
    fsyncDir(dir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
}

/** @type {typeof globalThis & { __polynoveaKeyRing?: { signature: string, ring: KeyRing | null } }} */
const holder = globalThis;

function cacheSignature(env) {
  return `${env.CMS_MASTER_KEY ?? ""}\u0000${configDir(env)}`;
}

/**
 * The key ring, or null when there is none yet (no CMS_MASTER_KEY and no master.key). With
 * `generate: true` (first boot) a missing master.key is created instead.
 */
/** @param {Env} [env] @param {{ generate?: boolean }} [options] @returns {KeyRing | null} */
export function loadKeyRing(env = process.env, options = {}) {
  const signature = cacheSignature(env);
  const cached = holder.__polynoveaKeyRing;
  if (cached?.signature === signature && (cached.ring || !options.generate)) return cached.ring;

  /** @type {KeyRing | null} */
  let ring = null;
  const fromEnv = env.CMS_MASTER_KEY?.trim();
  if (fromEnv) {
    ring = { source: "env", keys: parseMasterKeyRing(fromEnv) };
  } else {
    const file = masterKeyPath(env);
    if (!existsSync(file) && options.generate) createMasterKeyFile(env);
    if (existsSync(file)) {
      assertPrivateFile(file);
      ring = { source: "file", keys: parseMasterKeyRing(readFileSync(file, "utf8"), file) };
    }
  }
  holder.__polynoveaKeyRing = { signature, ring };
  return ring;
}

/** The key ring; throws with a fix when there is none. */
/** @param {Env} [env] @returns {KeyRing} */
export function requireKeyRing(env = process.env) {
  const ring = loadKeyRing(env);
  if (!ring) throw new KeyRingError(`No master key: set CMS_MASTER_KEY, or start the CMS once so it creates ${masterKeyPath(env)}`);
  return ring;
}

/** Forgets the cached ring (tests, and after rotation in the same process). */
export function resetKeyRingCache() {
  holder.__polynoveaKeyRing = undefined;
}

/** HKDF-SHA256 of one master key for one purpose. Different purposes never share key material. */
/** @param {MasterKey} master @param {KeyPurpose} purpose @returns {Buffer} */
export function deriveKey(master, purpose) {
  return Buffer.from(hkdfSync("sha256", master.key, HKDF_SALT, `polynovea/${purpose}/v1`, 32));
}

/** The derived keys of every master key for one purpose; the first encrypts or signs. */
/** @param {KeyRing} ring @param {KeyPurpose} purpose */
export function purposeKeys(ring, purpose) {
  const all = ring.keys.map((master) => ({ kid: master.kid, key: deriveKey(master, purpose) }));
  return { primary: all[0], all, byKid: (kid) => all.find((entry) => entry.kid === kid)?.key };
}

/**
 * The primary master key as `kid:base64`, for the wizard to show the owner once so they can store
 * it outside the server. Null when the key came from CMS_MASTER_KEY (the operator already has it).
 */
/** @param {Env} [env] @returns {string | null} */
export function masterKeyForOwner(env = process.env) {
  const ring = requireKeyRing(env);
  return ring.source === "file" ? formatMasterKeyRing([ring.keys[0]]) : null;
}
