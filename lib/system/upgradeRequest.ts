import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { checkForRelease, type ChannelCheck } from "./releaseChannel";
import { openUpgrade, recordUpgradeProgress, requestUpgrade, type UpgradeStatus, type UpgradeStep } from "./systemData";

/**
 * The CMS's half of an in-app upgrade (the host agent, release/packer/files/upgrade-agent.py, does the
 * rest). The CMS:
 *
 * 1. re-checks the release channel (a release is offered only after its signature verifies);
 * 2. records the request (one open upgrade at a time, audited);
 * 3. writes <data root>/upgrade-requests/request.json, which the agent's systemd path unit watches.
 *    The agent reads only "releaseId" from it; it fetches and verifies the release itself;
 * 4. reads the agent's status file (a root-owned folder mounted read-only into the container) and
 *    copies each new step into system_upgrades and platform_audit_events.
 *
 * When the new release does not declare its migrations compatible with the running one, a failed
 * upgrade restores the pre-upgrade backup (bundled database) or needs a manual restore (managed
 * database), so the admin must acknowledge that before the request is written.
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_STATUS_DIR = "/var/lib/polynovea-upgrade";
const MAX_STATUS_BYTES = 1024 * 1024;
const STEP_NAMES = new Set(["request", "verify", "wait", "backup", "pull", "migrate", "start", "health", "switch", "rollback", "restore"]);
const OUTCOMES = new Set(["started", "ok", "failed", "skipped"]);
const AGENT_STATUSES = new Set(["running", "succeeded", "rolled_back", "restore_needed", "failed"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SECRETISH = /(postgres(?:ql)?:\/\/\S+|password=\S+|PGPASSWORD=\S+)/gi;

export class UpgradeRequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** POLYNOVEA_UPGRADE_REQUEST_DIR / _STATUS_DIR exist for tests; installs use the defaults. */
export function upgradePaths(env: Env = process.env) {
  return {
    requestDir: env.POLYNOVEA_UPGRADE_REQUEST_DIR?.trim() || "/var/lib/polynovea/upgrade-requests",
    statusDir: env.POLYNOVEA_UPGRADE_STATUS_DIR?.trim() || DEFAULT_STATUS_DIR,
  };
}

/**
 * True when an upgrade agent is installed: its status folder is mounted into this container and holds
 * the agent's marker (`upgrade-agent.py --mark`, run by provision.sh). An empty folder, which Docker
 * creates for a missing bind-mount source, does not count.
 */
export async function upgradeAgentPresent(env: Env = process.env): Promise<boolean> {
  try {
    return (await fs.stat(path.join(upgradePaths(env).statusDir, "agent.json"))).isFile();
  } catch {
    return false;
  }
}

export interface StartUpgradeInput {
  actorId: string;
  releaseId: string;
  acknowledgeRestore?: boolean;
}

export async function startUpgrade(input: StartUpgradeInput, env: Env = process.env, check: (env: Env) => Promise<ChannelCheck> = checkForRelease): Promise<{ requestId: string; releaseId: string; rollback: string }> {
  if (!(await upgradeAgentPresent(env))) {
    throw new UpgradeRequestError("This server has no upgrade agent. Upgrades from the System page need the Polynovea VM image or the compose host setup.", 409);
  }
  const result = await check(env);
  if (result.error) throw new UpgradeRequestError(result.error, 502);
  if (!result.latest || !result.upgradeAvailable) throw new UpgradeRequestError("No newer signed release is available.", 409);
  if (result.latest.releaseId !== input.releaseId) throw new UpgradeRequestError("The release channel has changed; check for updates again.", 409);
  if (result.latest.rollback !== "compatible" && input.acknowledgeRestore !== true) {
    throw new UpgradeRequestError("This release's database changes cannot be undone by switching back. Confirm that a failed upgrade restores the pre-upgrade backup.", 428);
  }
  const requestId = randomUUID();
  await requestUpgrade({
    requestId,
    fromRelease: result.current.releaseId,
    toRelease: result.latest.releaseId,
    toVersion: result.latest.version,
    rollbackMode: result.latest.rollback,
    requestedBy: input.actorId,
  });
  await writeRequestFile(upgradePaths(env).requestDir, { releaseId: result.latest.releaseId, requestId });
  return { requestId, releaseId: result.latest.releaseId, rollback: result.latest.rollback };
}

/** Writes request.json atomically (temporary file in the same folder, then rename), private to the CMS user. */
export async function writeRequestFile(folder: string, body: { releaseId: string; requestId: string }): Promise<void> {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = path.join(folder, `.request.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(body)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, path.join(folder, "request.json"));
}

export interface AgentStatus {
  releaseId: string;
  status: Exclude<UpgradeStatus, "requested">;
  digest: string | null;
  startedAt: string;
  steps: UpgradeStep[];
}

/** Parses the agent's status.json, keeping only known fields; null when it is missing or malformed. */
export function parseAgentStatus(text: string): AgentStatus | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.schema !== 1) return null;
  if (typeof value.releaseId !== "string" || typeof value.status !== "string" || !AGENT_STATUSES.has(value.status)) return null;
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt)) || !Array.isArray(value.steps)) return null;
  const steps: UpgradeStep[] = [];
  for (const raw of value.steps.slice(0, 100)) {
    const step = raw as Record<string, unknown>;
    if (!step || typeof step.step !== "string" || !STEP_NAMES.has(step.step) || typeof step.outcome !== "string" || !OUTCOMES.has(step.outcome) || typeof step.at !== "string") continue;
    const entry: UpgradeStep = { step: step.step, outcome: step.outcome as UpgradeStep["outcome"], at: step.at.slice(0, 40) };
    if (typeof step.detail === "string") entry.detail = step.detail.replace(SECRETISH, "[redacted]").slice(0, 300);
    steps.push(entry);
  }
  return {
    releaseId: value.releaseId,
    status: value.status as AgentStatus["status"],
    digest: typeof value.digest === "string" && DIGEST.test(value.digest) ? value.digest : null,
    startedAt: value.startedAt,
    steps,
  };
}

/**
 * Copies the agent's progress into the open upgrade's record and audit log. Safe to call often (the
 * System page polls it; the Doctor calls it): each step is recorded once. Returns the status recorded.
 */
export const PICKUP_TIMEOUT_MS = 15 * 60_000;

export async function ingestAgentStatus(env: Env = process.env, now: () => number = Date.now): Promise<UpgradeStatus | null> {
  const open = await openUpgrade();
  if (!open) return null;
  const { statusDir, requestDir } = upgradePaths(env);
  let text: string | null = null;
  try {
    const handle = await fs.open(path.join(statusDir, "status.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { size } = await handle.stat();
      if (size <= MAX_STATUS_BYTES) text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    text = null;
  }
  const status = text === null ? null : parseAgentStatus(text);
  // The status file is for this request only if it names its release and started after the request.
  if (!status || status.releaseId !== open.to_release || Date.parse(status.startedAt) < Date.parse(open.requested_at) - 60_000) {
    // The agent never picked it up (refused the file, or is not installed): close it so it cannot block.
    if (open.status === "requested" && now() - Date.parse(open.requested_at) > PICKUP_TIMEOUT_MS) {
      const at = new Date(now()).toISOString();
      await recordUpgradeProgress({ requestId: open.request_id, status: "failed", steps: [{ step: "request", outcome: "failed", at, detail: "The upgrade agent did not start within 15 minutes." }], toDigest: null });
      await fs.rm(path.join(requestDir, "request.json"), { force: true }).catch(() => undefined);
      return "failed";
    }
    return open.status;
  }
  const recorded = await recordUpgradeProgress({ requestId: open.request_id, status: status.status, steps: status.steps, toDigest: status.digest });
  if (recorded && status.status !== "running") {
    await fs.rm(path.join(requestDir, "request.json"), { force: true }).catch(() => undefined);
  }
  return recorded ? status.status : open.status;
}
