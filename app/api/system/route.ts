import { requirePlatformAccess } from "@/lib/platform/permissions";
import { clientErrorMessage } from "@/lib/http/clientError";
import { checkForRelease } from "@/lib/system/releaseChannel";
import { listRestoreTests, listUpgrades } from "@/lib/system/systemData";
import { runSystemChecks } from "@/lib/system/systemProbes";
import { ingestAgentStatus, startUpgrade, upgradeAgentPresent, UpgradeRequestError } from "@/lib/system/upgradeRequest";
import { UpgradeInProgressError } from "@/lib/system/systemData";

// The System page: health checks, the release channel, upgrades and restore tests.
//   GET                          checks, upgrades, restore tests (and copies the agent's progress in)
//   GET ?release=1               also asks the release channel (verified before anything is shown)
//   POST {operation:"upgrade", releaseId, acknowledgeRestore?}   starts an upgrade (admin action only)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (data: unknown, status = 200) =>
  Response.json({ success: status < 400, data: status < 400 ? data : null, error: status >= 400 ? String(data) : null, timestamp: new Date().toISOString() }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  const auth = await requirePlatformAccess(req, { permission: ["infrastructure.diagnose"] });
  if (auth.error) return auth.error;
  try {
    await ingestAgentStatus().catch(() => null);
    const withRelease = new URL(req.url).searchParams.get("release") === "1";
    const [checks, upgrades, restoreTests, agent, release] = await Promise.all([
      runSystemChecks(),
      listUpgrades(10),
      listRestoreTests(10),
      upgradeAgentPresent(),
      withRelease ? checkForRelease() : Promise.resolve(null),
    ]);
    return json({ checks, upgrades, restoreTests, upgradeAgent: agent, release });
  } catch (error) {
    return json(clientErrorMessage(error, "Could not load the system state"), 500);
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json("Request body must be JSON", 400);
  }
  if (body?.operation !== "upgrade") return json("Unsupported system operation", 400);
  const auth = await requirePlatformAccess(req, { permission: "infrastructure.upgrade", stepUp: true });
  if (auth.error) return auth.error;
  if (typeof body.releaseId !== "string") return json("releaseId is required", 400);
  try {
    const result = await startUpgrade({ actorId: auth.data!.actor.adminUserId, releaseId: body.releaseId, acknowledgeRestore: body.acknowledgeRestore === true });
    return json(result, 202);
  } catch (error) {
    if (error instanceof UpgradeRequestError) return json(error.message, error.status);
    if (error instanceof UpgradeInProgressError) return json(error.message, 409);
    return json(clientErrorMessage(error, "Could not start the upgrade"), 500);
  }
}
