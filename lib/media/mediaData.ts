// Media area: database primitives for assets, replacement, the upload quota and storage resolution.
// The services (assetService, replacementService, uploadLimits, storageProvider) keep their
// validation, upload and storage logic and call these.
import type { EnvironmentKind } from "@/lib/infrastructure/types";
import * as postgres from "@/lib/media/mediaData.postgres";

export interface StorageConnectionRow {
  id: string;
  workspace_id: string;
  environment_id: string;
  connector_type: string;
  connector_family: string;
  name: string;
  status: string;
  active: boolean;
  config_json: Record<string, unknown>;
}

export interface EnvironmentRow {
  id: string;
  storage_provider: string | null;
  is_default: boolean;
  status: string;
  kind: EnvironmentKind;
}

export interface NewAssetRow {
  workspace_id: string;
  storage_provider: string;
  storage_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  alt_text: string | null;
  caption: string | null;
  folder: string;
  metadata_json: Record<string, unknown>;
  created_by: string;
}

export interface ReplaceAssetFileArgs {
  workspaceId: string;
  actorId: string;
  assetId: string;
  storageProvider: string;
  storageKey: string;
  checksum: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  reason: string;
}


export const listActiveAssets = postgres.listActiveAssets;
export const findActiveAssetByChecksum = postgres.findActiveAssetByChecksum;
export const insertAsset = postgres.insertAsset;
export const findAsset = postgres.findAsset;
export const replaceAssetFile = postgres.replaceAssetFile;
export const listAssetReplacements = postgres.listAssetReplacements;
export const activeAssetBytes = postgres.activeAssetBytes;
export const environmentKind = postgres.environmentKind;
export const exactStorageConnection = postgres.exactStorageConnection;
export const findEnvironment = postgres.findEnvironment;
export const defaultEnvironment = postgres.defaultEnvironment;
export const activeStorageConnections = postgres.activeStorageConnections;
