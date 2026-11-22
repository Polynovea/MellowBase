// Direct PostgreSQL implementation of the taxonomy area (phase 0 spike of the self-hosted upgrade).
//
// Same signatures and return shapes as taxonomyService.supabase.ts; the dispatcher in
// taxonomyService.ts picks one per POLYNOVEA_DATA_BACKEND. Differences that are deliberate:
// - Every list query has an explicit limit (PostgREST capped at 1000 rows; plain SQL does not).
// - Multi-step writes (term + localizations + aliases, version term reassignment) run in one
//   transaction, so a failure part-way no longer leaves half-written rows.
// - Localizations and aliases are loaded for the listed taxonomy's terms only, not the whole workspace.
// - Every statement is scoped by workspace_id, including the child-row deletes.
// - The audit row and its webhook deliveries are written in the same transaction as the change.
// Errors from the driver are thrown as they are; routes pass them through clientErrorMessage,
// which hides their internals from the API caller.
import { callFunction, DEFAULT_LIST_LIMIT, expectOne, getDb, maybeOne, withTransaction, type DbExecutor } from "@/lib/db/index";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import type { TaxonomyRow, TaxonomyTermRow, TermUsageSummary } from "@/lib/taxonomy/taxonomyService";

const LIST_LIMIT = DEFAULT_LIST_LIMIT;

type LocalizationRow = { term_id: string; locale: string; label: string; description: string | null };
type AliasRow = { term_id: string; alias: string; locale: string | null };

const normalizeSlug = (slug: string) => slug.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-");

// IDs in read paths come from URLs. Over PostgREST a malformed ID was a query error that the read
// functions ignored, so callers saw "not found" or an empty list; keep that, without hiding real
// database failures behind empty results.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID.test(value);

export async function listTaxonomies(workspaceId: string): Promise<TaxonomyRow[]> {
  return getDb()
    .selectFrom("taxonomies")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .orderBy("name", "asc")
    .limit(LIST_LIMIT)
    .execute();
}

export async function getTaxonomy(workspaceId: string, id: string): Promise<TaxonomyRow | null> {
  if (!isUuid(id)) return null;
  const rows = await getDb()
    .selectFrom("taxonomies")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", id)
    .execute();
  return maybeOne(rows);
}

export async function createTaxonomy(params: {
  workspaceId: string;
  actorAdminUserId: string;
  name: string;
  slug: string;
  description?: string | null;
  hierarchical?: boolean;
  modelRestrictions?: string[] | null;
}): Promise<TaxonomyRow> {
  return withTransaction(async (trx) => {
    const rows = await trx
      .insertInto("taxonomies")
      .values({
        workspace_id: params.workspaceId,
        name: params.name.trim(),
        slug: normalizeSlug(params.slug),
        description: params.description?.trim() || null,
        hierarchical: params.hierarchical ?? false,
        model_restrictions: params.modelRestrictions && params.modelRestrictions.length ? params.modelRestrictions : null,
      })
      .returningAll()
      .execute();
    const data = expectOne(rows, "Could not create taxonomy");

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "taxonomy.created",
      entityType: "taxonomy",
      entityId: data.id,
      metadata: { name: data.name, slug: data.slug },
    });

    return data;
  });
}

export async function updateTaxonomy(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
  name?: string;
  description?: string | null;
  modelRestrictions?: string[] | null;
}): Promise<TaxonomyRow> {
  const updates: { updated_at: string; name?: string; description?: string | null; model_restrictions?: string[] | null } = {
    updated_at: new Date().toISOString(),
  };
  if (params.name !== undefined) updates.name = params.name.trim();
  if (params.description !== undefined) updates.description = params.description?.trim() || null;
  if (params.modelRestrictions !== undefined) updates.model_restrictions = params.modelRestrictions;

  return withTransaction(async (trx) => {
    const rows = await trx
      .updateTable("taxonomies")
      .set(updates)
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.id)
      .returningAll()
      .execute();
    const data = expectOne(rows, "Could not update taxonomy");

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "taxonomy.updated",
      entityType: "taxonomy",
      entityId: data.id,
      metadata: updates,
    });

    return data;
  });
}

export async function deleteTaxonomy(params: {
  workspaceId: string;
  actorAdminUserId: string;
  id: string;
}): Promise<{ ok: true }> {
  await withTransaction(async (trx) => {
    await trx
      .deleteFrom("taxonomies")
      .where("workspace_id", "=", params.workspaceId)
      .where("id", "=", params.id)
      .execute();

    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "taxonomy.deleted",
      entityType: "taxonomy",
      entityId: params.id,
      metadata: {},
    });
  });

  return { ok: true };
}

// ── Terms & Hierarchy ────────────────────────────────────────────────────────

function selectTermLocalizations(db: DbExecutor, workspaceId: string) {
  return db.selectFrom("taxonomy_term_localizations").selectAll().where("workspace_id", "=", workspaceId);
}

function selectTermAliases(db: DbExecutor, workspaceId: string) {
  return db.selectFrom("taxonomy_term_aliases").selectAll().where("workspace_id", "=", workspaceId);
}

export async function listTerms(workspaceId: string, taxonomyId: string): Promise<TaxonomyTermRow[]> {
  if (!isUuid(taxonomyId)) return [];
  const db = getDb();
  const terms = (await db
    .selectFrom("taxonomy_terms")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("taxonomy_id", "=", taxonomyId)
    .orderBy("order_index", "asc")
    .orderBy("name", "asc")
    .orderBy("id", "asc")
    .limit(LIST_LIMIT)
    .execute()) as TaxonomyTermRow[];
  if (!terms.length) return [];

  // Children of exactly the listed terms. Bounded by the term limit, so no separate cap that could
  // cut off some terms' localizations or aliases at random.
  const termIds = terms.map((t) => t.id);
  const [localizations, aliases] = await Promise.all([
    selectTermLocalizations(db, workspaceId).where("term_id", "in", termIds).orderBy("term_id").orderBy("locale").execute() as Promise<LocalizationRow[]>,
    selectTermAliases(db, workspaceId).where("term_id", "in", termIds).orderBy("term_id").orderBy("alias").execute() as Promise<AliasRow[]>,
  ]);

  const termMap = new Map<string, TaxonomyTermRow>();
  for (const t of terms) {
    t.localizations = localizations.filter((l) => l.term_id === t.id);
    t.aliases = aliases.filter((a) => a.term_id === t.id);
    t.children = [];
    termMap.set(t.id, t);
  }

  const rootTerms: TaxonomyTermRow[] = [];
  for (const t of terms) {
    if (t.parent_term_id && termMap.has(t.parent_term_id)) {
      termMap.get(t.parent_term_id)!.children!.push(t);
    } else {
      rootTerms.push(t);
    }
  }

  return rootTerms;
}

export async function getTerm(workspaceId: string, termId: string): Promise<TaxonomyTermRow | null> {
  if (!isUuid(termId)) return null;
  const db = getDb();
  const term = maybeOne(
    await db.selectFrom("taxonomy_terms").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", termId).execute(),
  );
  if (!term) return null;

  const [localizations, aliases] = await Promise.all([
    selectTermLocalizations(db, workspaceId).where("term_id", "=", termId).limit(LIST_LIMIT).execute(),
    selectTermAliases(db, workspaceId).where("term_id", "=", termId).limit(LIST_LIMIT).execute(),
  ]);

  return {
    ...(term as TaxonomyTermRow),
    localizations,
    aliases,
  };
}

type TermChildren = {
  localizations?: { locale: string; label: string; description?: string | null }[];
  aliases?: { alias: string; locale?: string | null }[];
};

async function writeTermChildren(trx: DbExecutor, workspaceId: string, termId: string, children: TermChildren, replace: boolean) {
  if (children.localizations !== undefined) {
    if (replace) {
      await trx.deleteFrom("taxonomy_term_localizations").where("workspace_id", "=", workspaceId).where("term_id", "=", termId).execute();
    }
    if (children.localizations.length) {
      await trx
        .insertInto("taxonomy_term_localizations")
        .values(children.localizations.map((l) => ({
          workspace_id: workspaceId,
          term_id: termId,
          locale: l.locale,
          label: l.label,
          description: l.description || null,
        })))
        .execute();
    }
  }

  if (children.aliases !== undefined) {
    if (replace) {
      await trx.deleteFrom("taxonomy_term_aliases").where("workspace_id", "=", workspaceId).where("term_id", "=", termId).execute();
    }
    if (children.aliases.length) {
      await trx
        .insertInto("taxonomy_term_aliases")
        .values(children.aliases.map((a) => ({
          workspace_id: workspaceId,
          term_id: termId,
          alias: a.alias.trim(),
          locale: a.locale || null,
        })))
        .execute();
    }
  }
}

export async function createTerm(params: {
  workspaceId: string;
  actorAdminUserId: string;
  taxonomyId: string;
  parentTermId?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  orderIndex?: number;
  localizations?: { locale: string; label: string; description?: string | null }[];
  aliases?: { alias: string; locale?: string | null }[];
}): Promise<TaxonomyTermRow> {
  const term = await withTransaction(async (trx) => {
    const created = expectOne(
      await trx
        .insertInto("taxonomy_terms")
        .values({
          workspace_id: params.workspaceId,
          taxonomy_id: params.taxonomyId,
          parent_term_id: params.parentTermId || null,
          name: params.name.trim(),
          slug: normalizeSlug(params.slug),
          description: params.description?.trim() || null,
          order_index: params.orderIndex ?? 0,
        })
        .returningAll()
        .execute(),
      "Could not create taxonomy term",
    );
    await writeTermChildren(trx, params.workspaceId, created.id, {
      localizations: params.localizations?.length ? params.localizations : undefined,
      aliases: params.aliases?.length ? params.aliases : undefined,
    }, false);
    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "taxonomy.term.created",
      entityType: "taxonomy_term",
      entityId: created.id,
      metadata: { taxonomyId: params.taxonomyId, name: created.name, slug: created.slug },
    });
    return created;
  });

  return (await getTerm(params.workspaceId, term.id))!;
}

export async function updateTerm(params: {
  workspaceId: string;
  actorAdminUserId: string;
  termId: string;
  name?: string;
  description?: string | null;
  parentTermId?: string | null;
  orderIndex?: number;
  localizations?: { locale: string; label: string; description?: string | null }[];
  aliases?: { alias: string; locale?: string | null }[];
}): Promise<TaxonomyTermRow> {
  const updates: { updated_at: string; name?: string; description?: string | null; parent_term_id?: string | null; order_index?: number } = {
    updated_at: new Date().toISOString(),
  };
  if (params.name !== undefined) updates.name = params.name.trim();
  if (params.description !== undefined) updates.description = params.description?.trim() || null;
  if (params.parentTermId !== undefined) updates.parent_term_id = params.parentTermId;
  if (params.orderIndex !== undefined) updates.order_index = params.orderIndex;

  const term = await withTransaction(async (trx) => {
    const updated = expectOne(
      await trx
        .updateTable("taxonomy_terms")
        .set(updates)
        .where("workspace_id", "=", params.workspaceId)
        .where("id", "=", params.termId)
        .returningAll()
        .execute(),
      "Could not update taxonomy term",
    );
    await writeTermChildren(trx, params.workspaceId, params.termId, { localizations: params.localizations, aliases: params.aliases }, true);
    await recordPlatformEvent(trx, {
      workspaceId: params.workspaceId,
      actorAdminUserId: params.actorAdminUserId,
      action: "taxonomy.term.updated",
      entityType: "taxonomy_term",
      entityId: updated.id,
      metadata: updates,
    });
    return updated;
  });

  return (await getTerm(params.workspaceId, term.id))!;
}

/** Atomic term merge through cms_merge_taxonomy_terms; see taxonomyService.supabase.ts for the steps. */
export async function mergeTerms(params: {
  workspaceId: string;
  actorAdminUserId: string;
  sourceTermId: string;
  targetTermId: string;
}): Promise<{ ok: true; sourceTermId: string; targetTermId: string }> {
  if (params.sourceTermId === params.targetTermId) {
    throw new Error("Cannot merge a term into itself");
  }

  await callFunction("cms_merge_taxonomy_terms", {
    p_workspace_id: params.workspaceId,
    p_actor_id: params.actorAdminUserId,
    p_source_term_id: params.sourceTermId,
    p_target_term_id: params.targetTermId,
  });

  return { ok: true, sourceTermId: params.sourceTermId, targetTermId: params.targetTermId };
}

// ── Version-Aware Term Assignments ──────────────────────────────────────────

export async function assignVersionTerms(params: {
  workspaceId: string;
  entryId: string;
  versionId: string;
  termIds: string[];
}): Promise<void> {
  await withTransaction(async (trx) => {
    await trx
      .deleteFrom("content_entry_version_terms")
      .where("workspace_id", "=", params.workspaceId)
      .where("version_id", "=", params.versionId)
      .execute();

    if (params.termIds.length === 0) return;

    await trx
      .insertInto("content_entry_version_terms")
      .values(params.termIds.map((termId) => ({
        workspace_id: params.workspaceId,
        entry_id: params.entryId,
        version_id: params.versionId,
        term_id: termId,
      })))
      .execute();
  });
}

export async function getVersionTerms(workspaceId: string, versionId: string): Promise<TaxonomyTermRow[]> {
  if (!isUuid(versionId)) return [];
  // Was a PostgREST embed (taxonomy_terms(*)) over the composite foreign key (term_id, workspace_id).
  const rows = await getDb()
    .selectFrom("content_entry_version_terms as vt")
    .innerJoin("taxonomy_terms as t", (join) => join.onRef("t.id", "=", "vt.term_id").onRef("t.workspace_id", "=", "vt.workspace_id"))
    .selectAll("t")
    .where("vt.workspace_id", "=", workspaceId)
    .where("vt.version_id", "=", versionId)
    .limit(LIST_LIMIT)
    .execute();
  return rows as TaxonomyTermRow[];
}

export async function getTermUsage(workspaceId: string, termId: string): Promise<TermUsageSummary> {
  if (!isUuid(termId)) return { termId, usageCount: 0, entries: [] };
  const rows = await getDb()
    .selectFrom("content_entry_version_terms")
    .select(["entry_id", "version_id"])
    .where("workspace_id", "=", workspaceId)
    .where("term_id", "=", termId)
    .limit(LIST_LIMIT)
    .execute();

  const entries = rows.map((row) => ({
    entryId: row.entry_id,
    versionId: row.version_id,
  }));

  return {
    termId,
    usageCount: entries.length,
    entries,
  };
}
