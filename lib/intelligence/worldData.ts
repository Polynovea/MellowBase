// Intelligence area: the operational world model (discovery runs, nodes, edges, observations) and
// the generated desired state's inputs, with the backend dispatcher (the `intelligence` switch).
// worldModelService.ts keeps node and edge derivation and the probes.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/intelligence/worldData.postgres";
import * as supabase from "@/lib/intelligence/worldData.supabase";

export type { PersistedEdge } from "@/lib/intelligence/worldData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("intelligence") ? direct : supabase);

export const startDiscovery: typeof supabase.startDiscovery = (...args) => impl().startDiscovery(...args);
export const environmentRow: typeof supabase.environmentRow = (...args) => impl().environmentRow(...args);
export const discoveryInputs: typeof supabase.discoveryInputs = (...args) => impl().discoveryInputs(...args);
export const secretProvider: typeof supabase.secretProvider = (...args) => impl().secretProvider(...args);
export const recordDiscovery: typeof supabase.recordDiscovery = (...args) => impl().recordDiscovery(...args);
export const failDiscovery: typeof supabase.failDiscovery = (...args) => impl().failDiscovery(...args);
export const worldModel: typeof supabase.worldModel = (...args) => impl().worldModel(...args);
export const desiredStateInputs: typeof supabase.desiredStateInputs = (...args) => impl().desiredStateInputs(...args);
