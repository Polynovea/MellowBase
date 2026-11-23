// Readiness reads behind preflight (preflightService.ts) and destination assurance
// (assuranceService.ts), plus the read paths those use from webQualityService.ts and
// localizationService.ts, with the backend dispatcher (the `content` switch). The readiness rules stay
// in the services and are shared by both paths.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/assuranceData.postgres";
import * as supabase from "@/lib/content/assuranceData.supabase";

export type { AssetForAssurance } from "@/lib/content/assuranceData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const routesOfEntry: typeof supabase.routesOfEntry = (...args) => impl().routesOfEntry(...args);
export const activeRedirectFrom: typeof supabase.activeRedirectFrom = (...args) => impl().activeRedirectFrom(...args);
export const anyActiveRedirectFrom: typeof supabase.anyActiveRedirectFrom = (...args) => impl().anyActiveRedirectFrom(...args);
export const liveRouteAtPath: typeof supabase.liveRouteAtPath = (...args) => impl().liveRouteAtPath(...args);
export const liveRoutesOfLocale: typeof supabase.liveRoutesOfLocale = (...args) => impl().liveRoutesOfLocale(...args);
export const otherCurrentVersions: typeof supabase.otherCurrentVersions = (...args) => impl().otherCurrentVersions(...args);
export const translationOf: typeof supabase.translationOf = (...args) => impl().translationOf(...args);
export const activeCanonicalRoute: typeof supabase.activeCanonicalRoute = (...args) => impl().activeCanonicalRoute(...args);
export const assetsForAssurance: typeof supabase.assetsForAssurance = (...args) => impl().assetsForAssurance(...args);
export const siblingDraftData: typeof supabase.siblingDraftData = (...args) => impl().siblingDraftData(...args);
export const entryStatuses: typeof supabase.entryStatuses = (...args) => impl().entryStatuses(...args);
export const hasApprovedWorkflow: typeof supabase.hasApprovedWorkflow = (...args) => impl().hasApprovedWorkflow(...args);
export const webQualityPolicyRow: typeof supabase.webQualityPolicyRow = (...args) => impl().webQualityPolicyRow(...args);
export const workspaceLocales: typeof supabase.workspaceLocales = (...args) => impl().workspaceLocales(...args);
export const localizationRows: typeof supabase.localizationRows = (...args) => impl().localizationRows(...args);
