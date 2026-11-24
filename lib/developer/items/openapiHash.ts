import { createHash } from "node:crypto";
import type { OpenApiModelInput } from "@/lib/developer/items/openapi";

/** Workspace-level hash over the caller's models: `${apiKey}:${schemaHash}` sorted, joined by "|", SHA-256 hex. */
export function workspaceSchemaHash(models: ReadonlyArray<Pick<OpenApiModelInput, "apiKey" | "schemaHash">>): string {
  return createHash("sha256").update(models.map((model) => `${model.apiKey}:${model.schemaHash}`).sort().join("|")).digest("hex");
}
