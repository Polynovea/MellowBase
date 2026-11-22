// Workspace export reads (lib/developer/exportService.ts), with the backend dispatcher (the
// `developer` switch in POLYNOVEA_DATA_BACKEND). The export decides which tables and columns are
// portable; these helpers only read them.
//
// Behaviour change on the direct path: no row cap. Over PostgREST each read returned at most 1000
// rows, so an export of a workspace with more than 1000 rows in any table (entries, versions, audit
// events, ...) was silently incomplete.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/developer/exportData.postgres";
import * as supabase from "@/lib/developer/exportData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("developer") ? direct : supabase);

export const rowsForWorkspace: typeof supabase.rowsForWorkspace = (...args) => impl().rowsForWorkspace(...args);
export const rowsByIds: typeof supabase.rowsByIds = (...args) => impl().rowsByIds(...args);
export const exportedWorkspace: typeof supabase.exportedWorkspace = (...args) => impl().exportedWorkspace(...args);
