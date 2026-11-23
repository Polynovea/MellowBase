import type { PlatformInput } from "@/lib/http/routeData";

/**
 * The editable columns of a platform, validated from a PATCH body. Anything else in the body (id,
 * created_at, unknown keys) is ignored, so a request cannot rewrite columns it does not own.
 */
export function platformPatch(body: unknown): { ok: true; patch: PlatformInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Request body must be a JSON object" };
  const input = body as Record<string, unknown>;
  const patch: PlatformInput = {};
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return { ok: false, error: "Name must be a non-empty string" };
    patch.name = name;
  }
  for (const key of ["for_social", "for_ads", "is_active"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") return { ok: false, error: `${key} must be true or false` };
    patch[key] = input[key] as boolean;
  }
  if (input.sort_order !== undefined) {
    if (!Number.isInteger(input.sort_order) || (input.sort_order as number) < 0 || (input.sort_order as number) > 1_000_000) return { ok: false, error: "sort_order must be a whole number from 0 to 1000000" };
    patch.sort_order = input.sort_order as number;
  }
  return { ok: true, patch };
}
