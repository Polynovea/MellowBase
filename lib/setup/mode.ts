import pg from "pg";
import { postgresConnectionConfig } from "../infrastructure/postgresTls.mjs";
import { databaseUrlFromConfig, readConfigSync, type InstallConfig } from "./configStore.ts";
import { tlsConnectionFor, type ConnectionSettings } from "./installConnection.mjs";

/**
 * Which mode the CMS is in, decided at start-up and cached in this process:
 *
 *   no database settings                              → setup
 *   settings, database reachable, installation row   → running
 *   settings, database reachable, no row              → setup (resuming: the database step is done)
 *   settings, database unreachable or unreadable      → unavailable (503 everywhere but /api/health)
 *
 * "Database settings" are config.enc (written by the wizard) or, for installs configured the older
 * way, POLYNOVEA_DATABASE_URL / DATABASE_URL. An install that has settings never falls back to setup
 * mode when something is wrong: a database outage must not reopen the wizard to whoever finds it.
 *
 * Running is final for the life of the process. Setup is re-checked every few seconds (another
 * instance may have finished it) and unavailable is retried, so a database that comes back is picked
 * up without a restart. markInstalled() switches to running at the end of the owner step.
 *
 * Enforcement uses this twice: middleware.ts (routes) and lib/db/pool.ts plus assertMode() in route
 * handlers, because middleware alone can be bypassed (CVE-2025-29927).
 */

export type AppMode = "setup" | "running" | "unavailable";

export type ModeState = {
  mode: AppMode;
  /** Where the database settings came from; null in setup mode before the database step. */
  databaseSource: "config" | "env" | null;
  /** Setup mode only: the database is configured and migrated, so the wizard skips its database step. */
  databaseReady: boolean;
  /** For logs only (never shown to clients). */
  reason: string;
  checkedAt: number;
};

type Env = Record<string, string | undefined>;
type Holder = {
  state?: ModeState;
  pending?: Promise<ModeState>;
  config?: { value: InstallConfig | null };
  listeners: Set<(state: ModeState) => void>;
};

const RECHECK_MS: Record<AppMode, number> = { setup: 15_000, unavailable: 5_000, running: Number.POSITIVE_INFINITY };
const CHECK_TIMEOUT_MS = 5_000;

const store = globalThis as typeof globalThis & { __polynoveaMode?: Holder };
function holder(): Holder {
  store.__polynoveaMode ??= { listeners: new Set() };
  return store.__polynoveaMode;
}

function envDatabaseUrl(env: Env): string | null {
  return env.POLYNOVEA_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || env.Database_URL?.trim() || null;
}

/** config.enc, read once per process (cached, including "none"). Throws if it exists but cannot be read. */
export function installConfig(env: Env = process.env): InstallConfig | null {
  const h = holder();
  if (!h.config) h.config = { value: readConfigSync(env) };
  return h.config.value;
}

export type { ConnectionSettings };

/**
 * How to connect with config.enc's settings: TLS with exactly the wizard's CA bundle
 * (lib/setup/installConnection.mjs). Throws rather than fall back to weaker trust.
 */
export function installConnection(config: InstallConfig, role: "owner" | "app", env: Env = process.env): ConnectionSettings {
  return tlsConnectionFor(databaseUrlFromConfig(config, role), config.database, env);
}

/** Runtime (polynovea_app) connection settings: config.enc first, then the environment. Null before setup. */
export function runtimeConnection(env: Env = process.env): ConnectionSettings | null {
  const config = installConfig(env);
  if (config) return installConnection(config, "app", env);
  const url = envDatabaseUrl(env);
  return url ? postgresConnectionConfig(url, env) : null;
}

/**
 * The runtime (polynovea_app) connection URL: config.enc first, then the environment. Null when the
 * database is not configured yet.
 */
export function runtimeDatabaseUrl(env: Env = process.env): string | null {
  const config = installConfig(env);
  if (config) return databaseUrlFromConfig(config, "app");
  return envDatabaseUrl(env);
}

function settle(state: ModeState): ModeState {
  const h = holder();
  const previous = h.state?.mode;
  h.state = state;
  if (previous !== state.mode) for (const listener of h.listeners) listener(state);
  return state;
}

const now = () => Date.now();

/**
 * The same rule as migration 0072's backfill: any admin user, workspace member or content entry, or
 * any workspace other than the 'polynovea' workspace 0007 seeds on every fresh database.
 */
async function holdsInstall(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<Record<string, boolean>>(`
    select to_regclass('public.admin_users') is not null as admin_users,
           to_regclass('public.workspace_members') is not null as workspace_members,
           to_regclass('public.content_entries') is not null as content_entries,
           to_regclass('public.workspaces') is not null as workspaces`);
  const probes = [
    rows[0].admin_users && "select 1 from public.admin_users",
    rows[0].workspace_members && "select 1 from public.workspace_members",
    rows[0].content_entries && "select 1 from public.content_entries",
    rows[0].workspaces && "select 1 from public.workspaces where slug <> 'polynovea'",
  ].filter((probe): probe is string => Boolean(probe));
  if (!probes.length) return false;
  const live = await client.query<{ live: boolean }>(`select exists (${probes.map((probe) => `(${probe} limit 1)`).join(" union all ")}) as live`);
  return live.rows[0].live;
}

async function check(env: Env): Promise<ModeState> {
  let config: InstallConfig | null;
  try {
    config = installConfig(env);
  } catch (error) {
    // config.enc is there but cannot be read (wrong key, tampered file): never fall back to setup.
    return { mode: "unavailable", databaseSource: "config", databaseReady: false, reason: (error as Error).message, checkedAt: now() };
  }
  const url = config ? databaseUrlFromConfig(config, "app") : envDatabaseUrl(env);
  const source = config ? "config" : url ? "env" : null;
  if (!url || !source) return { mode: "setup", databaseSource: null, databaseReady: false, reason: "no database settings", checkedAt: now() };

  let client: pg.Client | undefined;
  try {
    // Inside the try: a CA bundle that cannot be loaded makes the CMS unavailable, never setup.
    const connection = config ? installConnection(config, "app", env) : postgresConnectionConfig(url, env);
    client = new pg.Client({
      ...connection,
      connectionTimeoutMillis: CHECK_TIMEOUT_MS,
      statement_timeout: CHECK_TIMEOUT_MS,
      query_timeout: CHECK_TIMEOUT_MS + 1_000,
      application_name: "polynovea-cms-mode",
    });
    await client.connect();
    const { rows } = await client.query<{ has_table: boolean }>("select to_regclass('public.installation') is not null as has_table");
    if (!rows[0].has_table) {
      // A database with an install but without migration 0072 is an upgrade whose migrations have not
      // run. Setup mode there would hand a live install to whoever reaches /setup first.
      if (await holdsInstall(client)) return { mode: "unavailable", databaseSource: source, databaseReady: false, reason: "migrations pending: run db:migrate", checkedAt: now() };
      return { mode: "setup", databaseSource: source, databaseReady: false, reason: "database not migrated yet", checkedAt: now() };
    }
    const installed = await client.query<{ installed: boolean }>("select exists (select 1 from public.installation where singleton) as installed");
    if (installed.rows[0].installed) return { mode: "running", databaseSource: source, databaseReady: true, reason: "installed", checkedAt: now() };
    // Users or content but no row (for example created outside the wizard): never open setup on it.
    if (await holdsInstall(client)) return { mode: "unavailable", databaseSource: source, databaseReady: false, reason: "the database holds an install but has no installation row", checkedAt: now() };
    return { mode: "setup", databaseSource: source, databaseReady: true, reason: "no installation row", checkedAt: now() };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { mode: "unavailable", databaseSource: source, databaseReady: false, reason: `database unreachable${code ? ` (${code})` : ""}`, checkedAt: now() };
  } finally {
    await client?.end().catch(() => {});
  }
}

/** The current mode, from the cache when it is fresh. Concurrent callers share one check. */
export async function resolveMode(env: Env = process.env): Promise<ModeState> {
  const h = holder();
  const cached = h.state;
  if (cached && now() - cached.checkedAt < RECHECK_MS[cached.mode]) return cached;
  h.pending ??= check(env)
    .then((state) => {
      // markInstalled() may have run while this check was in flight; running is final.
      if (h.state?.mode === "running") return h.state;
      if (state.mode === "unavailable" && h.state?.mode !== "unavailable") console.error(`[setup] CMS unavailable: ${state.reason}`);
      return settle(state);
    })
    .finally(() => {
      h.pending = undefined;
    });
  return h.pending;
}

/** The cached mode without checking (undefined before the first check, e.g. in scripts and tests). */
export function currentMode(): AppMode | undefined {
  return holder().state?.mode;
}

/** Called by the owner step once the installation row is committed: switches to running, no restart. */
export function markInstalled(): void {
  const h = holder();
  settle({ mode: "running", databaseSource: h.state?.databaseSource ?? null, databaseReady: true, reason: "installed", checkedAt: now() });
}

/** Called after the database step writes config.enc, so the next check reads the new settings. */
export function reloadInstallConfig(): void {
  const h = holder();
  h.config = undefined;
  if (h.state && h.state.mode !== "running") h.state = { ...h.state, checkedAt: 0 };
}

/** Runs `listener` whenever the mode changes (boot tasks stop their setup warnings this way). */
export function onModeChange(listener: (state: ModeState) => void): () => void {
  holder().listeners.add(listener);
  return () => holder().listeners.delete(listener);
}

export class ModeError extends Error {
  readonly status: 404 | 503;
  readonly mode: AppMode;
  constructor(mode: AppMode, expected: readonly AppMode[]) {
    super(`Not available in ${mode} mode (needs ${expected.join(" or ")})`);
    this.name = "ModeError";
    this.mode = mode;
    // Setup routes on a finished install are 404, exactly as the middleware answers.
    this.status = mode === "running" && !expected.includes("running") ? 404 : 503;
  }

  toResponse(): Response {
    const body = this.status === 404 ? { error: "Not found" } : { error: "The CMS is not ready", setup: this.mode === "setup" ? "/setup" : undefined };
    return Response.json(body, { status: this.status, headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * The second enforcement layer for route handlers: throws ModeError unless the CMS is in one of the
 * expected modes. `try { await assertMode("setup") } catch (e) { if (e instanceof ModeError) return e.toResponse(); throw e }`.
 */
export async function assertMode(expected: AppMode | readonly AppMode[]): Promise<ModeState> {
  const allowed: readonly AppMode[] = typeof expected === "string" ? [expected] : expected;
  const state = await resolveMode();
  if (!allowed.includes(state.mode)) throw new ModeError(state.mode, allowed);
  return state;
}

/** Tests only: forgets the cached mode and configuration. */
export function resetModeForTests(): void {
  const h = holder();
  h.state = undefined;
  h.pending = undefined;
  h.config = undefined;
  h.listeners.clear();
}
