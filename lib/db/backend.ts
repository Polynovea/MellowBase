/**
 * Per-area data backend switch for phase 1 of the self-hosted upgrade.
 *
 * POLYNOVEA_DATA_BACKEND chooses, for each code area, whether its queries go through supabase-js
 * (PostgREST) or straight to PostgreSQL through lib/db. A bare value sets the default for every
 * area; `area=value` pairs override single areas:
 *
 *   POLYNOVEA_DATA_BACKEND=supabase                      everything on Supabase (the default)
 *   POLYNOVEA_DATA_BACKEND=supabase,taxonomy=postgres    only taxonomy on the direct path
 *   POLYNOVEA_DATA_BACKEND=postgres,content=supabase     everything direct except content
 *
 * The value is read on every call, so tests can switch it and an operator can flip an area back
 * with an environment change and restart, without a new build. An unknown area or value is a
 * configuration error and throws rather than silently choosing a path. instrumentation.ts checks
 * the value when the server starts, so a typo stops the deploy instead of failing every request;
 * at request time the detail goes to the server log and the caller sees only a generic message.
 *
 * The switch is deleted at the end of phase 1, once every area runs on the direct path.
 */

export const DATA_BACKENDS = ["supabase", "postgres"] as const;
export type DataBackend = (typeof DATA_BACKENDS)[number];

/** The code areas that move one by one (lib/<area>), plus the routes that query directly. */
export const DATA_AREAS = [
  "admin",
  "content",
  "developer",
  "infrastructure",
  "intelligence",
  "media",
  "navigation",
  "operations",
  "platform",
  "routing",
  "schema",
  "taxonomy",
  "routes",
] as const;
export type DataArea = (typeof DATA_AREAS)[number];

const DEFAULT_BACKEND: DataBackend = "supabase";

function isBackend(value: string): value is DataBackend {
  return (DATA_BACKENDS as readonly string[]).includes(value);
}

function isArea(value: string): value is DataArea {
  return (DATA_AREAS as readonly string[]).includes(value);
}

/** Parses a POLYNOVEA_DATA_BACKEND value. Exported for tests and the System page. */
export function parseDataBackendSetting(raw: string | undefined): { defaultBackend: DataBackend; overrides: Partial<Record<DataArea, DataBackend>> } {
  let defaultBackend: DataBackend = DEFAULT_BACKEND;
  const overrides: Partial<Record<DataArea, DataBackend>> = {};
  if (!raw || !raw.trim()) return { defaultBackend, overrides };

  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq === -1) {
      if (!isBackend(token)) throw new Error(`POLYNOVEA_DATA_BACKEND: unknown backend "${token}" (use supabase or postgres)`);
      defaultBackend = token;
      continue;
    }
    const area = token.slice(0, eq).trim();
    const backend = token.slice(eq + 1).trim();
    if (!isArea(area)) throw new Error(`POLYNOVEA_DATA_BACKEND: unknown area "${area}"`);
    if (!isBackend(backend)) throw new Error(`POLYNOVEA_DATA_BACKEND: unknown backend "${backend}" for area ${area}`);
    overrides[area] = backend;
  }
  return { defaultBackend, overrides };
}

/** Throws with the detailed message if POLYNOVEA_DATA_BACKEND is malformed. Called once at server start. */
export function assertDataBackendSetting(env: Record<string, string | undefined> = process.env): void {
  parseDataBackendSetting(env.POLYNOVEA_DATA_BACKEND);
}

/** The backend the given area uses right now. */
export function dataBackendFor(area: DataArea, env: Record<string, string | undefined> = process.env): DataBackend {
  let parsed: ReturnType<typeof parseDataBackendSetting>;
  try {
    parsed = parseDataBackendSetting(env.POLYNOVEA_DATA_BACKEND);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    throw new Error("Server configuration error");
  }
  return parsed.overrides[area] ?? parsed.defaultBackend;
}

/** True when the area should use lib/db (direct PostgreSQL). */
export function usesDirectPostgres(area: DataArea, env?: Record<string, string | undefined>): boolean {
  return dataBackendFor(area, env) === "postgres";
}
