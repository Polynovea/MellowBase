import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { loadItemsOpenApiInputs } from "@/lib/developer/items/openapiInputs";
import { createTypesHandler } from "@/lib/developer/sdkTypes/typesRoute";

export const dynamic = "force-dynamic";

/** The caller's TypeScript types file (`polynovea-cms types pull`). Same auth as /api/v1/openapi.json. */
export const GET = createTypesHandler({
  auth: (req) => requireDeveloperApi(req, { scope: "schema.read" }),
  load: loadItemsOpenApiInputs,
});
