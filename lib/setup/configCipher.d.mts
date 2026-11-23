type Env = Record<string, string | undefined>;

export const CIPHERTEXT_PREFIX: "pv2.";
export function ciphertextKid(value: string): string | null;
export function secureConfigKeyAvailable(env?: Env): boolean;
export function encryptConfig(value: unknown, env?: Env): string;
export function decryptConfig<T = unknown>(value: string, env?: Env): T;
