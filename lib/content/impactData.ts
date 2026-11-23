// Content area: the dependency, impact and asset-usage graph reads, with the backend dispatcher
// (the `content` switch). impactGraphService.ts keeps the graph rules and calls these.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/content/impactData.postgres";
import * as supabase from "@/lib/content/impactData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("content") ? direct : supabase);

export const entryStates: typeof supabase.entryStates = (...args) => impl().entryStates(...args);
export const outgoingRelations: typeof supabase.outgoingRelations = (...args) => impl().outgoingRelations(...args);
export const incomingRelations: typeof supabase.incomingRelations = (...args) => impl().incomingRelations(...args);
export const releaseIdsForEntry: typeof supabase.releaseIdsForEntry = (...args) => impl().releaseIdsForEntry(...args);
export const destinationRows: typeof supabase.destinationRows = (...args) => impl().destinationRows(...args);
export const assetUsageRows: typeof supabase.assetUsageRows = (...args) => impl().assetUsageRows(...args);
