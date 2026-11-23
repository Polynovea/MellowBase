// Infrastructure area: workspace connections, with the backend dispatcher (the `infrastructure`
// switch). connectionService.ts keeps connector validation, credential preparation and verification.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/infrastructure/connectionData.postgres";
import * as supabase from "@/lib/infrastructure/connectionData.supabase";

export type { ConnectionRows, CreateConnectionArgs, RotateSecretArgs, VerificationArgs } from "@/lib/infrastructure/connectionData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("infrastructure") ? direct : supabase);

export const connectionRows: typeof supabase.connectionRows = (...args) => impl().connectionRows(...args);
export const environmentInWorkspace: typeof supabase.environmentInWorkspace = (...args) => impl().environmentInWorkspace(...args);
export const environmentProvider: typeof supabase.environmentProvider = (...args) => impl().environmentProvider(...args);
export const createConnection: typeof supabase.createConnection = (...args) => impl().createConnection(...args);
export const connectionRow: typeof supabase.connectionRow = (...args) => impl().connectionRow(...args);
export const secretBinding: typeof supabase.secretBinding = (...args) => impl().secretBinding(...args);
export const approvedRotationRequests: typeof supabase.approvedRotationRequests = (...args) => impl().approvedRotationRequests(...args);
export const rotateSecret: typeof supabase.rotateSecret = (...args) => impl().rotateSecret(...args);
export const markVerifying: typeof supabase.markVerifying = (...args) => impl().markVerifying(...args);
export const recordVerification: typeof supabase.recordVerification = (...args) => impl().recordVerification(...args);
