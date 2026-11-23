export type KeyPurpose = "config" | "secure-config" | "storage-signing";
export type MasterKey = { kid: string; key: Buffer };
export type KeyRing = { source: "env" | "legacy" | "file"; keys: MasterKey[] };
export type PurposeKeys = { primary: { kid: string; key: Buffer }; all: { kid: string; key: Buffer }[]; byKid(kid: string): Buffer | undefined };
type Env = Record<string, string | undefined>;

export const DEFAULT_CONFIG_DIR: string;
export const LEGACY_KID: "legacy";
export class KeyRingError extends Error {
  constructor(message: string);
}
export function configDir(env?: Env): string;
export function masterKeyPath(env?: Env): string;
export function parseMasterKeyRing(value: string, name?: string): MasterKey[];
export function formatMasterKeyRing(keys: MasterKey[]): string;
export function assertPrivateFile(file: string): void;
export function ensureConfigDir(env?: Env): string;
export function loadKeyRing(env?: Env, options?: { generate?: boolean }): KeyRing | null;
export function requireKeyRing(env?: Env): KeyRing;
export function resetKeyRingCache(): void;
export function deriveKey(master: MasterKey, purpose: KeyPurpose): Buffer;
export function purposeKeys(ring: KeyRing, purpose: KeyPurpose): PurposeKeys;
export function masterKeyForOwner(env?: Env): string | null;
