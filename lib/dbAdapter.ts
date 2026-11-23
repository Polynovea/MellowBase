// Legacy marketing tables (blog posts, live metrics, social posts, ad campaigns) used by the content
// and analytics routes, with the backend dispatcher (the `routes` switch).
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/dbAdapter.postgres";
import * as supabase from "@/lib/dbAdapter.supabase";

export type { TableName } from "@/lib/dbAdapter.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("routes") ? direct : supabase);

export const getDbItems: typeof supabase.getDbItems = (...args) => impl().getDbItems(...args);
export const insertDbItem: typeof supabase.insertDbItem = (...args) => impl().insertDbItem(...args);
export const updateDbItem: typeof supabase.updateDbItem = (...args) => impl().updateDbItem(...args);
export const getDbItem: typeof supabase.getDbItem = (...args) => impl().getDbItem(...args);
export const getDbItemByField: typeof supabase.getDbItemByField = (...args) => impl().getDbItemByField(...args);
export const deleteDbItem: typeof supabase.deleteDbItem = (...args) => impl().deleteDbItem(...args);
export const bulkUpsertMetrics: typeof supabase.bulkUpsertMetrics = (...args) => impl().bulkUpsertMetrics(...args);
