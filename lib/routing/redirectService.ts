// Routing area, redirect service: types and the backend dispatcher (the `routing` switch).
//
// Each function runs on Supabase (redirectService.supabase.ts) or directly on PostgreSQL
// (redirectService.postgres.ts). Both keep the same signatures and return shapes.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/routing/redirectService.postgres";
import * as supabase from "@/lib/routing/redirectService.supabase";

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

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("routing") ? direct : supabase);

export const detectRedirectLoop: typeof supabase.detectRedirectLoop = (...args) => impl().detectRedirectLoop(...args);
export const validateRedirectTarget: typeof supabase.validateRedirectTarget = (...args) => impl().validateRedirectTarget(...args);
export const listRedirects: typeof supabase.listRedirects = (...args) => impl().listRedirects(...args);
export const getRedirect: typeof supabase.getRedirect = (...args) => impl().getRedirect(...args);
export const createRedirect: typeof supabase.createRedirect = (...args) => impl().createRedirect(...args);
export const updateRedirect: typeof supabase.updateRedirect = (...args) => impl().updateRedirect(...args);
export const deleteRedirect: typeof supabase.deleteRedirect = (...args) => impl().deleteRedirect(...args);
export const importRedirects: typeof supabase.importRedirects = (...args) => impl().importRedirects(...args);
