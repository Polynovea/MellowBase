// PostgreSQL implementation of preview tokens and release previews (phase 1, wave 3).
//
// The embeds become explicit joins, each scoped to the token's or release's workspace:
// - a token's version must belong to its entry (v.entry_id = t.entry_id), its entry to the token's
// workspace, and the entry's model to the same workspace;
// - a release preview reads items through the release, each pinned version through its entry in the
// workspace, and the entry's model in the same workspace.
// Creating a token commits with its audit event. The public preview page looks a token up by its
// SHA-256 hash only, as before; an expired or revoked token resolves to nothing.
import { randomBytes } from "node:crypto";
import { expectOne, getDb, maybeOne, withTransaction } from "@/lib/db/index";
import { getEntry } from "@/lib/content/entryService";
import { recordPlatformEvent } from "@/lib/platform/audit.postgres";
import { hashPreviewToken as hash, previewExpiry } from "@/lib/content/previewService";
import { adminAccesses, sanitiseFor } from "@/lib/developer/items/sideChannels";

/**
 * Preview data passes the items API's permission function (phase 4): fields hidden from the token's
 * issuer are never shown on the preview. The token itself grants viewing its entry; field rules come
 * from the issuer's roles. A token whose issuer is no longer an active member shows no field data.
 */
const PREVIEW_GRANT = ["content.entry.read"];

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are passed through to the preview page as before */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createPreviewToken(params: { workspaceId: string; entryId: string; actorId: string; expiresInHours?: number }) {
  const entry = await getEntry(params.workspaceId, params.entryId);
  if (!entry?.current_draft_version_id) throw new Error("Entry draft not found");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = previewExpiry(params.expiresInHours);
  await withTransaction(async (trx) => {
    await trx.insertInto("preview_tokens").values({ workspace_id: params.workspaceId, entry_id: entry.id, entry_version_id: entry.current_draft_version_id, token_hash: hash(token), expires_at: expiresAt, created_by: params.actorId }).execute();
    await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "preview.token_created", entityType: "content_entry", entityId: entry.id, metadata: { expiresAt } });
  });
  return { token, expiresAt };
}

export async function createReleasePreviewToken(params: { workspaceId: string; releaseId: string; actorId: string; expiresInHours?: number }) {
  const release = UUID.test(params.releaseId)
    ? maybeOne(await getDb().selectFrom("releases as r")
      .select(["r.id", (eb) => eb.selectFrom("release_items").select((inner) => inner.fn.countAll<number>().as("n")).whereRef("release_items.release_id", "=", "r.id").as("items")])
      .where("r.id", "=", params.releaseId).where("r.workspace_id", "=", params.workspaceId).execute())
    : null;
  if (!release || !Number(release.items)) throw new Error("Release not found or has no items");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = previewExpiry(params.expiresInHours);
  await withTransaction(async (trx) => {
    await trx.insertInto("preview_tokens").values({ workspace_id: params.workspaceId, release_id: release.id, token_hash: hash(token), expires_at: expiresAt, created_by: params.actorId }).execute();
    await recordPlatformEvent(trx, { workspaceId: params.workspaceId, actorAdminUserId: params.actorId, action: "release.preview_token_created", entityType: "release", entityId: release.id, metadata: { expiresAt } });
  });
  return { token, expiresAt };
}

export async function resolvePreviewToken(token: string): Promise<any | null> {
  const db = getDb();
  const row = maybeOne(await db.selectFrom("preview_tokens as t")
    .leftJoin("content_entries as e", (join) => join.onRef("e.id", "=", "t.entry_id").onRef("e.workspace_id", "=", "t.workspace_id"))
    .leftJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
    .selectAll("t")
    .select(["e.id as e_id", "m.name as m_name", "m.api_key as m_api_key"])
    .where("t.token_hash", "=", hash(token)).where("t.revoked_at", "is", null).where("t.expires_at", ">", new Date().toISOString())
    .execute());
  if (!row) return null;
  const version = row.entry_version_id && row.e_id
    ? maybeOne(await db.selectFrom("content_entry_versions").selectAll().where("id", "=", row.entry_version_id).where("entry_id", "=", row.e_id).execute())
    : null;
  await db.updateTable("preview_tokens").set({ last_used_at: new Date().toISOString() }).where("id", "=", row.id).execute();
  const { e_id, m_name, m_api_key, ...tokenRow } = row;
  // Null when the issuer is no longer an active member: the page then says the link is no longer valid.
  const accesses = await adminAccesses(db, row.workspace_id, row.created_by, "preview", m_api_key ? [m_api_key] : [], PREVIEW_GRANT);
  return {
    ...tokenRow,
    issuer_active: accesses !== null,
    content_entry_versions: version ? { ...version, data_jsonb: sanitiseFor(accesses, m_api_key, version.data_jsonb) } : null,
    content_entries: e_id ? { content_models: m_api_key ? { name: m_name, api_key: m_api_key } : null } : null,
  };
}

/** `viewer`: the admin the preview is shown as (the release preview token's issuer); fields hidden from them are removed. */
export async function getReleasePreview(workspaceId: string, releaseId: string, viewer: { adminUserId: string | null }): Promise<any | null> {
  if (!UUID.test(releaseId)) return null;
  const db = getDb();
  const release = maybeOne(await db.selectFrom("releases").select(["id", "name", "description"]).where("workspace_id", "=", workspaceId).where("id", "=", releaseId).execute());
  if (!release) return null;
  const items = await db.selectFrom("release_items as i")
    .leftJoin("content_entries as e", (join) => join.onRef("e.id", "=", "i.entry_id").on("e.workspace_id", "=", workspaceId))
    .leftJoin("content_entry_versions as v", (join) => join.onRef("v.id", "=", "i.entry_version_id").onRef("v.entry_id", "=", "e.id"))
    .leftJoin("content_models as m", (join) => join.onRef("m.id", "=", "e.content_model_id").onRef("m.workspace_id", "=", "e.workspace_id"))
    .select(["i.entry_id", "i.entry_version_id", "v.id as v_id", "v.data_jsonb", "v.locale", "e.id as e_id", "m.name as m_name", "m.api_key as m_api_key"])
    .where("i.release_id", "=", release.id)
    .orderBy("i.created_at").orderBy("i.id").execute();
  const accesses = await adminAccesses(db, workspaceId, viewer.adminUserId, "preview", items.map((item) => item.m_api_key).filter((key): key is string => Boolean(key)), PREVIEW_GRANT);
  return {
    ...release,
    release_items: items.map((item) => ({
      entry_id: item.entry_id,
      entry_version_id: item.entry_version_id,
      content_entry_versions: item.v_id
        ? { data_jsonb: sanitiseFor(accesses, item.m_api_key, item.data_jsonb), locale: item.locale, content_entries: item.e_id ? { content_models: item.m_api_key ? { name: item.m_name, api_key: item.m_api_key } : null } : null }
        : null,
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
