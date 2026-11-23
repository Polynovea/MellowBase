// Taxonomy area: types.
//
// The queries run on PostgreSQL in taxonomyService.postgres.ts.
import * as postgres from "@/lib/taxonomy/taxonomyService.postgres";

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


export const listTaxonomies = postgres.listTaxonomies;
export const getTaxonomy = postgres.getTaxonomy;
export const createTaxonomy = postgres.createTaxonomy;
export const updateTaxonomy = postgres.updateTaxonomy;
export const deleteTaxonomy = postgres.deleteTaxonomy;
export const listTerms = postgres.listTerms;
export const getTerm = postgres.getTerm;
export const createTerm = postgres.createTerm;
export const updateTerm = postgres.updateTerm;
export const mergeTerms = postgres.mergeTerms;
export const assignVersionTerms = postgres.assignVersionTerms;
export const getVersionTerms = postgres.getVersionTerms;
export const getTermUsage = postgres.getTermUsage;
