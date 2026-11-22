// Taxonomy area: types and the backend dispatcher.
//
// Each function runs on Supabase (taxonomyService.supabase.ts) or directly on PostgreSQL
// (taxonomyService.postgres.ts), chosen per call by POLYNOVEA_DATA_BACKEND (see lib/db/backend.ts).
// Both implementations keep the same signatures and return shapes, so the routes do not change.
import { usesDirectPostgres } from "@/lib/db/backend";
import * as postgres from "@/lib/taxonomy/taxonomyService.postgres";
import * as supabase from "@/lib/taxonomy/taxonomyService.supabase";

export interface TaxonomyRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  hierarchical: boolean;
  model_restrictions: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface TaxonomyTermRow {
  id: string;
  workspace_id: string;
  taxonomy_id: string;
  parent_term_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  order_index: number;
  is_deprecated: boolean;
  deprecated_by_term_id: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  localizations?: { locale: string; label: string; description: string | null }[];
  aliases?: { alias: string; locale: string | null }[];
  children?: TaxonomyTermRow[];
}

export interface TermUsageSummary {
  termId: string;
  usageCount: number;
  entries: { entryId: string; versionId: string }[];
}

// Compile-time check that the direct implementation matches the Supabase one exactly.
const direct: typeof supabase = postgres;
const impl = (): typeof supabase => (usesDirectPostgres("taxonomy") ? direct : supabase);

export const listTaxonomies: typeof supabase.listTaxonomies = (...args) => impl().listTaxonomies(...args);
export const getTaxonomy: typeof supabase.getTaxonomy = (...args) => impl().getTaxonomy(...args);
export const createTaxonomy: typeof supabase.createTaxonomy = (...args) => impl().createTaxonomy(...args);
export const updateTaxonomy: typeof supabase.updateTaxonomy = (...args) => impl().updateTaxonomy(...args);
export const deleteTaxonomy: typeof supabase.deleteTaxonomy = (...args) => impl().deleteTaxonomy(...args);
export const listTerms: typeof supabase.listTerms = (...args) => impl().listTerms(...args);
export const getTerm: typeof supabase.getTerm = (...args) => impl().getTerm(...args);
export const createTerm: typeof supabase.createTerm = (...args) => impl().createTerm(...args);
export const updateTerm: typeof supabase.updateTerm = (...args) => impl().updateTerm(...args);
export const mergeTerms: typeof supabase.mergeTerms = (...args) => impl().mergeTerms(...args);
export const assignVersionTerms: typeof supabase.assignVersionTerms = (...args) => impl().assignVersionTerms(...args);
export const getVersionTerms: typeof supabase.getVersionTerms = (...args) => impl().getVersionTerms(...args);
export const getTermUsage: typeof supabase.getTermUsage = (...args) => impl().getTermUsage(...args);
