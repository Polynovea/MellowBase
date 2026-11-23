// Routing area, redirect service: types.
//
// The queries run on PostgreSQL in redirectService.postgres.ts.
import * as postgres from "@/lib/routing/redirectService.postgres";

export interface RedirectRow {
  id: string;
  workspace_id: string;
  locale: string | null;
  source_path: string;
  target_path: string;
  status_code: 301 | 302 | 307 | 308;
  is_active: boolean;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RedirectValidationResult {
  valid: boolean;
  error?: string;
  isLoop: boolean;
  isBrokenTarget: boolean;
}

export interface BulkImportItem {
  sourcePath: string;
  targetPath: string;
  statusCode?: number;
  locale?: string | null;
  description?: string;
}

export interface BulkImportReport {
  dryRun: boolean;
  totalRows: number;
  validCount: number;
  errorCount: number;
  errors: { row: number; sourcePath: string; error: string }[];
  imported: RedirectRow[];
}


export const detectRedirectLoop = postgres.detectRedirectLoop;
export const validateRedirectTarget = postgres.validateRedirectTarget;
export const listRedirects = postgres.listRedirects;
export const getRedirect = postgres.getRedirect;
export const createRedirect = postgres.createRedirect;
export const updateRedirect = postgres.updateRedirect;
export const deleteRedirect = postgres.deleteRedirect;
export const importRedirects = postgres.importRedirects;
