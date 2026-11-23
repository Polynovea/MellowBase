// Content area: content analytics snapshots, GA4 connectors and sync state, with the backend
// dispatcher (the `content` switch). analyticsService.ts and analyticsIntelligenceService.ts keep
// the input checks, the GA4 calls, path matching and the comparison.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/analyticsData.postgres";
import * as supabase from "@/lib/content/analyticsData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const upsertSnapshot: typeof supabase.upsertSnapshot = (...args) => impl().upsertSnapshot(...args);
export const versionBelongsToEntry: typeof supabase.versionBelongsToEntry = (...args) => impl().versionBelongsToEntry(...args);
export const entrySnapshots: typeof supabase.entrySnapshots = (...args) => impl().entrySnapshots(...args);
export const ensureGa4Connector: typeof supabase.ensureGa4Connector = (...args) => impl().ensureGa4Connector(...args);
export const overviewRows: typeof supabase.overviewRows = (...args) => impl().overviewRows(...args);
export const connectorById: typeof supabase.connectorById = (...args) => impl().connectorById(...args);
export const upsertSyncState: typeof supabase.upsertSyncState = (...args) => impl().upsertSyncState(...args);
export const connectionForSync: typeof supabase.connectionForSync = (...args) => impl().connectionForSync(...args);
export const syncTargets: typeof supabase.syncTargets = (...args) => impl().syncTargets(...args);
export const writeSyncSnapshots: typeof supabase.writeSyncSnapshots = (...args) => impl().writeSyncSnapshots(...args);
export const performanceRows: typeof supabase.performanceRows = (...args) => impl().performanceRows(...args);
