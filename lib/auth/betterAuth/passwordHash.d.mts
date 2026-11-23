export function hashPassword(password: string): Promise<string>;
export function isBcryptHash(hash: string): boolean;
/** True when a stored hash should be replaced with a fresh Argon2id hash after a successful sign-in. */
export function needsRehash(hash: string): boolean;
export function verifyPassword(input: { hash: string; password: string }): Promise<boolean>;
