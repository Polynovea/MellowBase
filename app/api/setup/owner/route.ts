import { ownerSummary } from "@/lib/setup/owner/actions";
import { handleOwnerRequest } from "@/lib/setup/owner/http";

/** GET /api/setup/owner: the owner step's progress (no secrets), for the wizard page to resume. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleOwnerRequest(request, ownerSummary);
}
