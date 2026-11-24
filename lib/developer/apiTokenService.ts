// Developer API tokens: scopes, token generation and validation (shared). Tokens are random 256-bit
// values with a `pnv_` prefix; only their SHA-256 hash is stored, and lookups are by that hash.
import { createHash, randomBytes } from "node:crypto";
import * as postgres from "@/lib/developer/apiTokenService.postgres";

export const DEVELOPER_API_SCOPES = [
  "content.read",
  "content.write",
  "content.publish",
  "content.delete",
  /** Read drafts through the items API (a site's preview mode). */
  "content.preview",
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
  /** Workspace role whose field permissions apply (items API); null = the creator's roles. */
  roleId: string | null;
  /** Never the raw token: persistence sees only its prefix and SHA-256 hash. */
  tokenPrefix: string;
  tokenHash: string;
}

export interface RateLimitResult { allowed: boolean; limit: number; remaining: number; resetAt: string }


export const listDeveloperApiTokens = postgres.listDeveloperApiTokens;
export const revokeDeveloperApiToken = postgres.revokeDeveloperApiToken;
export const consumeDeveloperApiRateLimit = postgres.consumeDeveloperApiRateLimit;
export const touchDeveloperApiToken = postgres.touchDeveloperApiToken;

export async function createDeveloperApiToken(params: {
  workspaceId: string;
  actorId: string;
  name: string;
  scopes: string[];
  allowedModels?: string[];
  expiresAt?: string | null;
  rateLimitPerMinute?: number;
  roleId?: string | null;
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
  const roleId = params.roleId ? params.roleId.trim() : null;
  if (roleId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roleId)) throw new Error("Token role is invalid");
  const prepared: PreparedDeveloperApiToken = { name, scopes, allowedModels, rateLimit, expiresAt: params.expiresAt ?? null, roleId, tokenPrefix, tokenHash: digest(rawToken) };
  const data = await postgres.insertDeveloperApiToken({ workspaceId: params.workspaceId, actorId: params.actorId, token: prepared });
  return { token: data, secret: rawToken };
}

export async function resolveDeveloperApiToken(rawToken: string) {
  return postgres.findDeveloperApiTokenByHash(digest(rawToken));
}
