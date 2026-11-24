/**
 * Webhook payloads through the one permission function. Content webhooks carry ids and metadata, not
 * field values; but any field data an event's metadata does carry (`data`, `data_jsonb`, `before`,
 * `after`) is sanitised for each subscription with the access of the admin who owns it, and lists of
 * field keys (`fields`, `changedFields`) keep only keys that admin can read. A payload whose model or
 * owner cannot be resolved loses those keys entirely (fail closed). Payloads without such keys are
 * passed through untouched, with no extra query.
 */
import type { Kysely } from "kysely";
import type { DB } from "@/lib/db/generated/database";
import type { DbExecutor } from "@/lib/db/index";
import { sanitise, type ModelAccess } from "@/lib/developer/items/access";
import { adminAccesses } from "@/lib/developer/items/sideChannels";

const DATA_KEYS = ["data", "data_jsonb", "before", "after"] as const;
const FIELD_LIST_KEYS = ["fields", "changedFields"] as const;

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** True when the metadata carries anything field-shaped that needs the permission function. */
export function carriesFieldData(metadata: unknown): boolean {
  return isPlain(metadata) && [...DATA_KEYS, ...FIELD_LIST_KEYS].some((key) => key in metadata);
}

/** The model a payload is about: metadata.model / metadata.modelApiKey (api key). */
export function payloadModel(metadata: Record<string, unknown>): string | null {
  for (const key of ["model", "modelApiKey"]) if (typeof metadata[key] === "string" && metadata[key]) return metadata[key] as string;
  return null;
}

/** Pure: the metadata as one subscription's owner may see it. */
export function webhookMetadataFor(metadata: Record<string, unknown>, access: ModelAccess | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((DATA_KEYS as readonly string[]).includes(key)) {
      if (access && isPlain(value)) out[key] = sanitise(access, value, "out");
      continue;
    }
    if ((FIELD_LIST_KEYS as readonly string[]).includes(key)) {
      if (access && Array.isArray(value)) out[key] = value.filter((item) => typeof item === "string" && access.readable.has(item));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The payload for one subscription (owned by `ownerAdminUserId`). */
export async function webhookPayloadFor(
  executor: DbExecutor,
  workspaceId: string,
  ownerAdminUserId: string | null,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const metadata = payload.metadata;
  if (!carriesFieldData(metadata)) return payload;
  const meta = metadata as Record<string, unknown>;
  const model = payloadModel(meta);
  const accesses = model ? await adminAccesses(executor as Kysely<DB>, workspaceId, ownerAdminUserId, "webhook", [model]) : null;
  return { ...payload, metadata: webhookMetadataFor(meta, (model && accesses?.get(model)) || null) };
}
