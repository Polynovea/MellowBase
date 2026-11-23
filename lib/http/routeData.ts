// Queries API routes made directly, with the backend dispatcher (the `routes` switch). The routes
// keep authorization, model-access filtering and their response shapes.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/http/routeData.postgres";
import * as supabase from "@/lib/http/routeData.supabase";

export type { MemberProfile, PlatformFilter, PlatformInput } from "@/lib/http/routeData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("routes") ? direct : supabase);

export const listPlatforms: typeof supabase.listPlatforms = (...args) => impl().listPlatforms(...args);
export const createPlatform: typeof supabase.createPlatform = (...args) => impl().createPlatform(...args);
export const updatePlatform: typeof supabase.updatePlatform = (...args) => impl().updatePlatform(...args);
export const deletePlatform: typeof supabase.deletePlatform = (...args) => impl().deletePlatform(...args);
export const entryIdsInModels: typeof supabase.entryIdsInModels = (...args) => impl().entryIdsInModels(...args);
export const searchDocuments: typeof supabase.searchDocuments = (...args) => impl().searchDocuments(...args);
export const activeMemberProfiles: typeof supabase.activeMemberProfiles = (...args) => impl().activeMemberProfiles(...args);
export const storageKeyRegistered: typeof supabase.storageKeyRegistered = (...args) => impl().storageKeyRegistered(...args);
export const extensionInstallations: typeof supabase.extensionInstallations = (...args) => impl().extensionInstallations(...args);
export const importRuns: typeof supabase.importRuns = (...args) => impl().importRuns(...args);
export const schemaRuns: typeof supabase.schemaRuns = (...args) => impl().schemaRuns(...args);
export const versionModelKeys: typeof supabase.versionModelKeys = (...args) => impl().versionModelKeys(...args);
export const entryModelKeys: typeof supabase.entryModelKeys = (...args) => impl().entryModelKeys(...args);
