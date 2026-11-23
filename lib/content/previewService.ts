// Content area, preview tokens and release previews: shared token rules and the backend dispatcher
// (the `content` switch). Tokens are 256-bit random values; only their SHA-256 hash is stored.
import { createHash } from "node:crypto";
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/previewService.postgres";
import * as supabase from "@/lib/content/previewService.supabase";

export const hashPreviewToken = (token: string) => createHash("sha256").update(token).digest("hex");
/** 1 to 168 hours from now, 24 by default. */
export const previewExpiry = (hours?: number) => new Date(Date.now() + Math.min(Math.max(hours ?? 24, 1), 168) * 3_600_000).toISOString();

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const createPreviewToken: typeof supabase.createPreviewToken = (...args) => impl().createPreviewToken(...args);
export const createReleasePreviewToken: typeof supabase.createReleasePreviewToken = (...args) => impl().createReleasePreviewToken(...args);
export const resolvePreviewToken: typeof supabase.resolvePreviewToken = (...args) => impl().resolvePreviewToken(...args);
export const getReleasePreview: typeof supabase.getReleasePreview = (...args) => impl().getReleasePreview(...args);
