import { loadKeyRing, masterKeyPath } from "./keyRing.ts";
import { installConfig, onModeChange, resolveMode, type ModeState } from "./mode.ts";
import { installPeerStamp } from "./peerStamp.ts";
import { issueAndPrintSetupCode } from "./setupCode.ts";

/**
 * Start-up work, run once from instrumentation.ts before the server takes requests:
 *
 * 1. Make sure a master key exists (first boot creates master.key unless CMS_MASTER_KEY is set).
 * 2. Load config.enc and hand its auth secret to the auth settings when .env does not set one.
 * 3. Decide the mode. In setup mode, log the setup URL, and while the server listens on a
 *    non-loopback address, repeat a warning every 5 minutes until setup is finished.
 *
 * In setup mode it also issues the one-time setup code (setupCode.ts) and prints it with the URL,
 * and installs the peer stamp (peerStamp.ts) so the wizard's request guards can see the real
 * connection. A POLYNOVEA_SETUP_CODE that is too weak throws here and stops the server.
 */

type Env = Record<string, string | undefined>;
type Logger = Pick<Console, "info" | "warn" | "error">;

export const SETUP_WARNING_INTERVAL_MS = 5 * 60 * 1000;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

/** The address the server binds to: HOSTNAME (Next standalone) or HOST; unset means every interface. */
export function listenAddress(env: Env = process.env): string | null {
  return env.HOSTNAME?.trim() || env.HOST?.trim() || null;
}

export function listensOnPublicAddress(env: Env = process.env): boolean {
  const address = listenAddress(env);
  return !address || !LOOPBACK.test(address);
}

/** Where the owner opens the wizard: POLYNOVEA_PUBLIC_URL, else this server's own address and port. */
export function setupUrl(env: Env = process.env): string {
  const publicUrl = env.POLYNOVEA_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (publicUrl) return `${publicUrl}/setup`;
  const address = listenAddress(env);
  const host = !address || address === "0.0.0.0" || address === "::" ? "<this server's address>" : address;
  return `http://${host}:${env.PORT?.trim() || "3000"}/setup`;
}

/**
 * Logs how to reach the wizard. The setup-code lane calls this with the one-time code once it has
 * issued one; without a code only the URL is logged. Logged only in setup mode, never anywhere else.
 */
export function announceSetupAccess(options: { code?: string; env?: Env; logger?: Logger } = {}): void {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const lines = ["[setup] This CMS is not set up yet.", `[setup] Open ${setupUrl(env)} to finish setup.`];
  if (options.code) lines.push(`[setup] Setup code: ${options.code}  (works once, for 1 hour; a restart issues a new one)`);
  logger.info(lines.join("\n"));
}

type Timers = { warning?: ReturnType<typeof setInterval>; unsubscribe?: () => void };
const store = globalThis as typeof globalThis & { __polynoveaBootTimers?: Timers };

function stopSetupWarnings() {
  const timers = store.__polynoveaBootTimers;
  if (timers?.warning) clearInterval(timers.warning);
  timers?.unsubscribe?.();
  store.__polynoveaBootTimers = undefined;
}

/** Repeats a warning while the CMS sits uninitialised on a public address. Stops when setup finishes. */
export function startSetupWarnings(env: Env = process.env, logger: Logger = console): boolean {
  stopSetupWarnings();
  if (!listensOnPublicAddress(env)) return false;
  const warn = () =>
    logger.warn(`[setup] WARNING: this CMS is not set up and is reachable on a public address. Whoever completes setup first owns it. Finish setup now at ${setupUrl(env)}, or bind it to 127.0.0.1 until you can.`);
  warn();
  const warning = setInterval(warn, SETUP_WARNING_INTERVAL_MS);
  warning.unref?.();
  const unsubscribe = onModeChange((state) => {
    if (state.mode !== "setup") stopSetupWarnings();
  });
  store.__polynoveaBootTimers = { warning, unsubscribe };
  return true;
}

export async function runBootTasks(env: Env = process.env, logger: Logger = console): Promise<ModeState> {
  try {
    const ring = loadKeyRing(env, { generate: true });
    if (ring?.source === "file") logger.info(`[setup] Master key: ${masterKeyPath(env)}. Keep a copy away from the database backups.`);
  } catch (error) {
    // Without a key ring the CMS can still read legacy secrets; the System Doctor reports it.
    logger.error(`[setup] Master key unavailable: ${(error as Error).message}`);
  }

  try {
    const config = installConfig(env);
    if (config && !env.POLYNOVEA_AUTH_SECRET?.trim()) env.POLYNOVEA_AUTH_SECRET = config.authSecret;
  } catch {
    // resolveMode reports an unreadable config.enc as unavailable, with the reason.
  }

  const state = await resolveMode(env);
  if (state.mode !== "running") installPeerStamp();
  if (state.mode === "setup") {
    issueAndPrintSetupCode({ env, announce: (issued) => announceSetupAccess({ code: issued.display ?? undefined, env, logger }) });
    startSetupWarnings(env, logger);
  } else if (state.mode === "unavailable") {
    logger.error(`[setup] CMS unavailable: ${state.reason}. Every route but /api/health answers 503 until this is fixed.`);
  }
  return state;
}
