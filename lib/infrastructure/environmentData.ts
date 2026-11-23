// Infrastructure area: environments, credential lookups and connection lookups, with the backend
// dispatcher (the `infrastructure` switch). The services keep normalization and decryption.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/infrastructure/environmentData.postgres";
import * as supabase from "@/lib/infrastructure/environmentData.supabase";

export type { CreateEnvironmentArgs, EnvironmentRows, SecretRef, UpdateEnvironmentArgs } from "@/lib/infrastructure/environmentData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("infrastructure") ? direct : supabase);

export const environmentRows: typeof supabase.environmentRows = (...args) => impl().environmentRows(...args);
export const createEnvironment: typeof supabase.createEnvironment = (...args) => impl().createEnvironment(...args);
export const updateEnvironment: typeof supabase.updateEnvironment = (...args) => impl().updateEnvironment(...args);
export const secretRef: typeof supabase.secretRef = (...args) => impl().secretRef(...args);
export const secretProvider: typeof supabase.secretProvider = (...args) => impl().secretProvider(...args);
export const secretBindings: typeof supabase.secretBindings = (...args) => impl().secretBindings(...args);
export const databaseConnections: typeof supabase.databaseConnections = (...args) => impl().databaseConnections(...args);
export const activeSupabaseConnection: typeof supabase.activeSupabaseConnection = (...args) => impl().activeSupabaseConnection(...args);
