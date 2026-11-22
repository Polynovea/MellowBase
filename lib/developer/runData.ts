// Developer run records (schema delivery runs and import runs): database primitives with the
// backend dispatcher (the `developer` switch in POLYNOVEA_DATA_BACKEND). schemaDeliveryService.ts
// and importService.ts keep their planning, validation and import logic.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/developer/runData.postgres";
import * as supabase from "@/lib/developer/runData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("developer") ? direct : supabase);

export const insertSchemaRun: typeof supabase.insertSchemaRun = (...args) => impl().insertSchemaRun(...args);
export const insertImportRun: typeof supabase.insertImportRun = (...args) => impl().insertImportRun(...args);
export const updateImportRun: typeof supabase.updateImportRun = (...args) => impl().updateImportRun(...args);
