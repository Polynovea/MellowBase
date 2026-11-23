// The hasher lives in passwordHash.mjs so plain Node scripts can use it too.
export { hashPassword, isBcryptHash, needsRehash, verifyPassword } from "./passwordHash.mjs";
