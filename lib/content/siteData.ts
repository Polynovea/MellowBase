// Content area: the localization writes (locales, translation links) and the web-quality reads
// (policy writes, sitemap, site audit), with the backend dispatcher (the `content` switch).
// localizationService.ts and webQualityService.ts keep their rules and call these.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/siteData.postgres";
import * as supabase from "@/lib/content/siteData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const callConfigureLocale: typeof supabase.callConfigureLocale = (...args) => impl().callConfigureLocale(...args);
export const versionLocale: typeof supabase.versionLocale = (...args) => impl().versionLocale(...args);
export const upsertTranslationLink: typeof supabase.upsertTranslationLink = (...args) => impl().upsertTranslationLink(...args);
export const findTranslationLink: typeof supabase.findTranslationLink = (...args) => impl().findTranslationLink(...args);
export const updateTranslationLink: typeof supabase.updateTranslationLink = (...args) => impl().updateTranslationLink(...args);
export const markStale: typeof supabase.markStale = (...args) => impl().markStale(...args);
export const callUpsertWebQualityPolicy: typeof supabase.callUpsertWebQualityPolicy = (...args) => impl().callUpsertWebQualityPolicy(...args);
export const sitemapRows: typeof supabase.sitemapRows = (...args) => impl().sitemapRows(...args);
export const siteAuditRows: typeof supabase.siteAuditRows = (...args) => impl().siteAuditRows(...args);
