import { requireDeveloperApi } from "@/lib/developer/apiAuth";
import { loadItemsOpenApiInputs } from "@/lib/developer/sdkTypes/pendingLoader";
import { createTypesHandler } from "@/lib/developer/sdkTypes/typesRoute";

/** The caller's TypeScript types file (`polynovea-cms types pull`). Same auth as /api/v1/openapi.json. */
export const GET = createTypesHandler({
  auth: (req) => requireDeveloperApi(req, { scope: "schema.read" }),
  load: loadItemsOpenApiInputs,
});
