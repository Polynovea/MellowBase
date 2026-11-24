/**
 * Placeholder until W1 exports its per-caller loader (agreed name: loadItemsOpenApiInputs, the same
 * inputs /api/v1/openapi.json uses). Until then /api/v1/types.ts answers 500 TYPES_BUILD_FAILED.
 * Replace the import in app/api/v1/types.ts/route.ts and delete this file when W1's loader lands.
 */
import type { ItemsOpenApiLoader } from "@/lib/developer/sdkTypes/typesRoute";

export const loadItemsOpenApiInputs: ItemsOpenApiLoader = async () => {
  throw new Error("The items OpenAPI loader is not available yet");
};
