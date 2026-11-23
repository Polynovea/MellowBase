import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { assertPrivateFile, configDir, ensureConfigDir, KeyRingError, loadKeyRing, purposeKeys, requireKeyRing } from "./keyRing.mjs";

/**
 * config.enc: the install's own settings, written by the setup wizard and never kept in .env.
 *
 *   <POLYNOVEA_CONFIG_DIR>/config.enc = {"v":1,"kid":"…","iv":"…","tag":"…","ct":"…"}
 *
 * AES-256-GCM under the key ring's `config` key, with additional authenticated data
 * "polynovea-config:v1". The file is written atomically (temporary file, fsync, rename), mode 0600 in
 * a 0700 folder owned by the user the CMS runs as.
 *
 * The database host is stored as a name, never a resolved IP, so a managed database that fails over
 * to a new address keeps working; the wizard's pinning applies only to its own checks.
 *
 * Plain JavaScript (types, including InstallConfig, in configStore.d.mts) so scripts such as
 * run-migrations.mjs read config.enc with the same code as the app.
 */

/** @typedef {import("./configStore.d.mts").InstallConfig} InstallConfig */
/** @typedef {Record<string, string | undefined>} Env */

const AAD = Buffer.from("polynovea-config:v1");
const FILE_NAME = "config.enc";

/** @param {Env} [env] */
export function configPath(env = process.env) {
  return path.join(configDir(env), FILE_NAME);
}

/** @param {Env} [env] */
export function configExists(env = process.env) {
  return existsSync(configPath(env));
}

/** A new random secret (base64url), e.g. for authSecret or backupRepoPassword. */
export function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

const ROLE_NAME = /^[a-z_][a-z0-9_$]{0,62}$/;
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;
const HOST = /^[A-Za-z0-9.\-:[\]]{1,253}$/;

/** @param {string} field @returns {never} */
function fail(field) {
  throw new Error(`Invalid install configuration: ${field}`);
}

/** Validates a parsed or caller-built config. Throws naming the field, never the value. */
/** @param {unknown} value @returns {InstallConfig} */
export function validateInstallConfig(value) {
  const c = /** @type {any} */ (value);
  if (!c || typeof c !== "object" || c.v !== 1) fail("version");
  if (!["local", "managed", "created"].includes(c.databaseMode)) fail("databaseMode");
  const db = c.database;
  if (!db || typeof db.host !== "string" || !HOST.test(db.host)) fail("database.host");
  if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535) fail("database.port");
  if (typeof db.name !== "string" || !DB_NAME.test(db.name)) fail("database.name");
  if (db.caBundleId !== null && (typeof db.caBundleId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(db.caBundleId))) fail("database.caBundleId");
  for (const role of /** @type {const} */ (["owner", "app"])) {
    const entry = c.roles?.[role];
    if (!entry || typeof entry.user !== "string" || !ROLE_NAME.test(entry.user)) fail(`roles.${role}.user`);
    if (typeof entry.password !== "string" || entry.password.length < 16) fail(`roles.${role}.password`);
  }
  if (c.roles.owner.user === c.roles.app.user) fail("roles (owner and app must be different logins)");
  if (typeof c.authSecret !== "string" || c.authSecret.length < 32) fail("authSecret");
  if (c.backupRepoPassword !== null && (typeof c.backupRepoPassword !== "string" || c.backupRepoPassword.length < 16)) fail("backupRepoPassword");
  return {
    v: 1,
    databaseMode: c.databaseMode,
    database: { host: db.host, port: db.port, name: db.name, caBundleId: db.caBundleId },
    roles: {
      owner: { user: c.roles.owner.user, password: c.roles.owner.password },
      app: { user: c.roles.app.user, password: c.roles.app.password },
    },
    authSecret: c.authSecret,
    backupRepoPassword: c.backupRepoPassword,
  };
}

/** @param {InstallConfig} config @param {Env} [env] @returns {string} */
export function encryptInstallConfig(config, env = process.env) {
  const { primary } = purposeKeys(requireKeyRing(env), "config");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(validateInstallConfig(config)), "utf8"), cipher.final()]);
  const envelope = { v: 1, kid: primary.kid, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  return JSON.stringify(envelope);
}

/** @param {string} text @param {Env} [env] @returns {InstallConfig} */
export function decryptInstallConfig(text, env = process.env) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("config.enc is not valid JSON");
  }
  if (!envelope || envelope.v !== 1 || typeof envelope.kid !== "string" || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ct !== "string") {
    throw new Error("config.enc has an unknown format");
  }
  const ring = loadKeyRing(env);
  if (!ring) throw new KeyRingError("config.enc exists but there is no master key: restore CMS_MASTER_KEY or master.key");
  const key = purposeKeys(ring, "config").byKid(envelope.kid);
  if (!key) throw new KeyRingError(`config.enc was encrypted with master key ${envelope.kid}, which is not in the key ring`);
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("config.enc has an unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new KeyRingError(`config.enc could not be decrypted with master key ${envelope.kid}: the file or the key is wrong`);
  }
  return validateInstallConfig(JSON.parse(plain));
}

/**
 * Synchronous read for start-up code and scripts. Null when there is no config.enc; throws (naming
 * fields, never values) when it exists but cannot be used: callers must refuse, not fall back.
 * @param {Env} [env] @returns {InstallConfig | null}
 */
export function readInstallConfigSync(env = process.env) {
  const file = configPath(env);
  if (!existsSync(file)) return null;
  assertPrivateFile(file);
  return decryptInstallConfig(readFileSync(file, "utf8"), env);
}

/** Same as readInstallConfigSync (the name the app code uses). */
export const readConfigSync = readInstallConfigSync;

/** The install configuration, or null before the wizard's database step has saved one. @param {Env} [env] */
export async function readConfig(env = process.env) {
  return readInstallConfigSync(env);
}

/**
 * Saves the configuration atomically: a crash leaves the old file or the new one, never half of
 * one. Encrypts under the primary master key (creating master.key on first use if needed).
 */
/** @param {InstallConfig} config @param {Env} [env] @returns {Promise<void>} */
export async function writeConfig(config, env = process.env) {
  const dir = ensureConfigDir(env);
  loadKeyRing(env, { generate: true });
  const body = encryptInstallConfig(config, env);
  const target = configPath(env);
  const temp = path.join(dir, `.${FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, target);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
  if (process.platform !== "win32") {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

/** Connection URL for one of the install's roles (TLS is applied by postgresTls.mjs). */
/** @param {InstallConfig} config @param {"owner" | "app"} role @returns {string} */
export function databaseUrlFromConfig(config, role) {
  const login = config.roles[role];
  const host = config.database.host.includes(":") && !config.database.host.startsWith("[") ? `[${config.database.host}]` : config.database.host;
  const url = new URL(`postgresql://${host}:${config.database.port}/`);
  url.username = encodeURIComponent(login.user);
  url.password = encodeURIComponent(login.password);
  url.pathname = `/${encodeURIComponent(config.database.name)}`;
  return url.toString();
}
