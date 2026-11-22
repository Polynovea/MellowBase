// Developer API tokens: scopes, token generation and validation (shared), and the backend
// dispatcher (the `developer` switch in POLYNOVEA_DATA_BACKEND). Tokens are random 256-bit values
// with a `pnv_` prefix; only their SHA-256 hash is stored, and lookups are by that hash.
import { createHash, randomBytes } from "node:crypto";
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/developer/apiTokenService.postgres";
import * as supabase from "@/lib/developer/apiTokenService.supabase";

export const DEVELOPER_API_SCOPES = [
  "content.read",
  "content.write",
  "content.publish",
  "content.delete",
  "media.read",
  "media.write",
  "schema.read",
  "schema.write",
  "releases.read",
  "releases.write",
  "analytics.read",
  "environment.read",
  "environment.write",
  "connection.read",
  "connection.write",
  "infrastructure.read",
  "infrastructure.write",
  "operational_intelligence.read",
  "operational_intelligence.write",
  "operational_intelligence.execute",
  "operational_intelligence.policy",
  "agent.read",
  "agent.manage",
  "extension.read",
  "extension.manage",
] as const;

export type DeveloperApiScope = (typeof DEVELOPER_API_SCOPES)[number];

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function validateScopes(scopes: string[]): DeveloperApiScope[] {
  const allowed = new Set<string>(DEVELOPER_API_SCOPES);
  const unique = [...new Set(scopes)];
  const invalid = unique.filter((scope) => !allowed.has(scope));
  if (invalid.length) throw new Error(`Unsupported API token scope(s): ${invalid.join(", ")}`);
  return unique as DeveloperApiScope[];
}

export interface PreparedDeveloperApiToken {
  name: string;
  scopes: DeveloperApiScope[];
  allowedModels: string[];
  rateLimit: number;
  expiresAt: string | null;
  /** Never the raw token: persistence sees only its prefix and SHA-256 hash. */
  tokenPrefix: string;
  tokenHash: string;
}

export interface RateLimitResult { allowed: boolean; limit: number; remaining: number; resetAt: string }

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("developer") ? direct : supabase);

export const listDeveloperApiTokens: typeof supabase.listDeveloperApiTokens = (...args) => impl().listDeveloperApiTokens(...args);
export const revokeDeveloperApiToken: typeof supabase.revokeDeveloperApiToken = (...args) => impl().revokeDeveloperApiToken(...args);
export const consumeDeveloperApiRateLimit: typeof supabase.consumeDeveloperApiRateLimit = (...args) => impl().consumeDeveloperApiRateLimit(...args);
export const touchDeveloperApiToken: typeof supabase.touchDeveloperApiToken = (...args) => impl().touchDeveloperApiToken(...args);

export async function createDeveloperApiToken(params: {
  workspaceId: string;
  actorId: string;
  name: string;
  scopes: string[];
  allowedModels?: string[];
  expiresAt?: string | null;
  rateLimitPerMinute?: number;
}) {
  const name = params.name.trim();
  if (!name) throw new Error("Token name is required");
  const scopes = validateScopes(params.scopes);
  if (!scopes.length) throw new Error("At least one API scope is required");
  const allowedModels = [...new Set((params.allowedModels ?? []).map((item) => item.trim()).filter(Boolean))];
  const rateLimit = params.rateLimitPerMinute ?? 120;
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10_000) throw new Error("Rate limit must be between 1 and 10000 requests per minute");
  if (params.expiresAt && Number.isNaN(new Date(params.expiresAt).getTime())) throw new Error("Token expiry is invalid");

  const rawToken = `pnv_${randomBytes(32).toString("base64url")}`;
  const tokenPrefix = rawToken.slice(0, 12);
  const prepared: PreparedDeveloperApiToken = { name, scopes, allowedModels, rateLimit, expiresAt: params.expiresAt ?? null, tokenPrefix, tokenHash: digest(rawToken) };
  const data = await impl().insertDeveloperApiToken({ workspaceId: params.workspaceId, actorId: params.actorId, token: prepared });
  return { token: data, secret: rawToken };
}

export async function resolveDeveloperApiToken(rawToken: string) {
  return impl().findDeveloperApiTokenByHash(digest(rawToken));
}
