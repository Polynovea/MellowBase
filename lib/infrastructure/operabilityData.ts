// Infrastructure area: environment components, System Doctor runs, the operability overview and
// provisioning runs, with the backend dispatcher (the `infrastructure` switch). operabilityService.ts
// keeps capability inference, the doctor's findings and the provisioning checks.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/infrastructure/operabilityData.postgres";
import * as supabase from "@/lib/infrastructure/operabilityData.supabase";

export type { ApprovalQuery, ComponentInputs, DoctorInputs, OperabilityOverview, ProvisioningCompletion } from "@/lib/infrastructure/operabilityData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("infrastructure") ? direct : supabase);

export const approvedRequests: typeof supabase.approvedRequests = (...args) => impl().approvedRequests(...args);
export const markApprovalExecuted: typeof supabase.markApprovalExecuted = (...args) => impl().markApprovalExecuted(...args);
export const componentInputs: typeof supabase.componentInputs = (...args) => impl().componentInputs(...args);
export const saveComponents: typeof supabase.saveComponents = (...args) => impl().saveComponents(...args);
export const doctorInputs: typeof supabase.doctorInputs = (...args) => impl().doctorInputs(...args);
export const secretProviderKind: typeof supabase.secretProviderKind = (...args) => impl().secretProviderKind(...args);
export const schemaDeploymentState: typeof supabase.schemaDeploymentState = (...args) => impl().schemaDeploymentState(...args);
export const recordDoctorRun: typeof supabase.recordDoctorRun = (...args) => impl().recordDoctorRun(...args);
export const overview: typeof supabase.overview = (...args) => impl().overview(...args);
export const provisioningRunByKey: typeof supabase.provisioningRunByKey = (...args) => impl().provisioningRunByKey(...args);
export const startProvisioningRun: typeof supabase.startProvisioningRun = (...args) => impl().startProvisioningRun(...args);
export const markComponentPresent: typeof supabase.markComponentPresent = (...args) => impl().markComponentPresent(...args);
export const completeProvisioningRun: typeof supabase.completeProvisioningRun = (...args) => impl().completeProvisioningRun(...args);
export const failProvisioningRun: typeof supabase.failProvisioningRun = (...args) => impl().failProvisioningRun(...args);
