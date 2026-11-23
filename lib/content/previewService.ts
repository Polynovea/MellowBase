// Content area, preview tokens and release previews: shared token rules. Tokens are 256-bit random
// values; only their SHA-256 hash is stored.
import { createHash } from "node:crypto";
import * as postgres from "@/lib/content/previewService.postgres";

export const hashPreviewToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** 1 to 168 hours from now, 24 by default. */
export const previewExpiry = (hours?: number) => new Date(Date.now() + Math.min(Math.max(hours ?? 24, 1), 168) * 3_600_000).toISOString();


export const createPreviewToken = postgres.createPreviewToken;
export const createReleasePreviewToken = postgres.createReleasePreviewToken;
export const resolvePreviewToken = postgres.resolvePreviewToken;
export const getReleasePreview = postgres.getReleasePreview;
