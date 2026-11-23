// Infrastructure area: schema deployments, backups and restores, portability, upgrades, website
// bindings, approval requests and component actions, with the backend dispatcher (the
// `infrastructure` switch). operabilityService.ts keeps the gates, checksums and provider adapters.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/infrastructure/controlPlaneData.postgres";
import * as supabase from "@/lib/infrastructure/controlPlaneData.supabase";

export type { ApprovalRow, ComponentRun, EnvironmentRow, RequestApprovalArgs, ReviewApprovalArgs, SchemaDeployment, UpgradeCompletion, WebsiteBinding } from "@/lib/infrastructure/controlPlaneData.supabase";

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("infrastructure") ? direct : supabase);

export const environmentRow: typeof supabase.environmentRow = (...args) => impl().environmentRow(...args);
export const latestSchemaDeployment: typeof supabase.latestSchemaDeployment = (...args) => impl().latestSchemaDeployment(...args);
export const latestApprovedSchemaPromotion: typeof supabase.latestApprovedSchemaPromotion = (...args) => impl().latestApprovedSchemaPromotion(...args);
export const approvalById: typeof supabase.approvalById = (...args) => impl().approvalById(...args);
export const recordSchemaDeployment: typeof supabase.recordSchemaDeployment = (...args) => impl().recordSchemaDeployment(...args);
export const backupSources: typeof supabase.backupSources = (...args) => impl().backupSources(...args);
export const insertBackup: typeof supabase.insertBackup = (...args) => impl().insertBackup(...args);
export const backupRow: typeof supabase.backupRow = (...args) => impl().backupRow(...args);
export const insertRestoreRun: typeof supabase.insertRestoreRun = (...args) => impl().insertRestoreRun(...args);
export const portabilityRows: typeof supabase.portabilityRows = (...args) => impl().portabilityRows(...args);
export const runtimeState: typeof supabase.runtimeState = (...args) => impl().runtimeState(...args);
export const insertUpgradeRun: typeof supabase.insertUpgradeRun = (...args) => impl().insertUpgradeRun(...args);
export const upgradeRun: typeof supabase.upgradeRun = (...args) => impl().upgradeRun(...args);
export const verifiedBackup: typeof supabase.verifiedBackup = (...args) => impl().verifiedBackup(...args);
export const completeUpgrade: typeof supabase.completeUpgrade = (...args) => impl().completeUpgrade(...args);
export const websiteBinding: typeof supabase.websiteBinding = (...args) => impl().websiteBinding(...args);
export const bindWebsite: typeof supabase.bindWebsite = (...args) => impl().bindWebsite(...args);
export const websiteBindingById: typeof supabase.websiteBindingById = (...args) => impl().websiteBindingById(...args);
export const markWebsiteTesting: typeof supabase.markWebsiteTesting = (...args) => impl().markWebsiteTesting(...args);
export const requestApproval: typeof supabase.requestApproval = (...args) => impl().requestApproval(...args);
export const reviewApproval: typeof supabase.reviewApproval = (...args) => impl().reviewApproval(...args);
export const componentRow: typeof supabase.componentRow = (...args) => impl().componentRow(...args);
export const recordComponentRun: typeof supabase.recordComponentRun = (...args) => impl().recordComponentRun(...args);
