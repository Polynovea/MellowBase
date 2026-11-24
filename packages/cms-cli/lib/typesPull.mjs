// `polynovea-cms types pull [--out file] [--check] [--url base] [--token-file path]`
//
// Writes the caller's types file from GET /api/v1/types.ts. `--check` writes nothing and exits
// 0 when the local file is current, 1 when it is out of date or missing, 2 when it cannot check.
// The token comes from POLYNOVEA_CMS_TOKEN or --token-file, never a flag (shell history, process list).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_OUT = "polynovea-cms.ts";
const MARKER = /^\/\/ schema-hash: [0-9a-f]{64}\n/;

class UsageError extends Error {}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9.-]+\.localhost)$/i;

/** https, or http to this machine only. No credentials in the URL. */
export function checkBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new UsageError(`Not a valid URL: ${raw}`); }
  if (url.username || url.password) throw new UsageError("The CMS URL must not contain a user name or password. Use POLYNOVEA_CMS_TOKEN or --token-file.");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK.test(url.hostname)) return url.origin;
  if (url.protocol === "http:") throw new UsageError(`Refusing plain http to ${url.hostname}: the API token would travel unencrypted. Use https://${url.host}.`);
  throw new UsageError(`Unsupported URL scheme ${url.protocol}`);
}

function readToken({ flags, env, cwd }) {
  if (flags.token !== undefined) throw new UsageError("--token is not accepted (it ends up in shell history and the process list). Set POLYNOVEA_CMS_TOKEN or pass --token-file <path>.");
  if (flags["token-file"] !== undefined) {
    if (typeof flags["token-file"] !== "string") throw new UsageError("--token-file needs a path");
    let text;
    try { text = readFileSync(resolve(cwd, flags["token-file"]), "utf8"); } catch { throw new UsageError(`Cannot read the token file ${flags["token-file"]}`); }
    const token = text.trim();
    if (!token) throw new UsageError(`The token file ${flags["token-file"]} is empty`);
    return token;
  }
  const token = env.POLYNOVEA_CMS_TOKEN?.trim();
  if (!token) throw new UsageError("Set POLYNOVEA_CMS_TOKEN (a token with the schema.read scope) or pass --token-file <path>.");
  return token;
}

const normalise = (text) => text.replace(/\r\n/g, "\n");

/** model -> hash, from a types file's `schema` constant. */
export function modelHashes(text) {
  const out = new Map();
  const block = text.slice(text.indexOf("export const schema = {"));
  for (const match of block.matchAll(/^ {4}("?[^":\s]+"?): \{ hash: "([0-9a-f]{64})"/gm)) out.set(match[1].replace(/"/g, ""), match[2]);
  return out;
}

function describeDrift(local, remote) {
  const before = modelHashes(local);
  const after = modelHashes(remote);
  const lines = [];
  for (const [model, hash] of after) {
    if (!before.has(model)) lines.push(`  + ${model} (new)`);
    else if (before.get(model) !== hash) lines.push(`  ~ ${model} (${before.get(model).slice(0, 12)} -> ${hash.slice(0, 12)})`);
  }
  for (const model of before.keys()) if (!after.has(model)) lines.push(`  - ${model} (no longer readable by this token)`);
  return lines.length ? lines : ["  field access or formatting changed (model hashes are the same)"];
}

async function fetchTypes({ base, token, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${base}/api/v1/types.ts`, { headers: { authorization: `Bearer ${token}`, accept: "text/plain" }, redirect: "error" });
  } catch (error) {
    throw new UsageError(`Could not reach ${base}: ${error?.cause?.code ?? error?.message ?? "network error"}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { const body = JSON.parse(text); if (body?.error?.message) message = `${body.error.code ?? response.status}: ${body.error.message}`; } catch { /* not JSON */ }
    throw new UsageError(`${base} refused the types request (${message})`);
  }
  const types = normalise(text);
  if (!MARKER.test(types)) throw new UsageError(`${base} did not return a Polynovea types file`);
  return types;
}

/**
 * Run the command. Returns the exit code; never prints the token.
 * @param {{ flags: Record<string, unknown>, env?: Record<string, string | undefined>, cwd?: string,
 *   fetch?: typeof fetch, log?: (message: string) => void, error?: (message: string) => void }} deps
 * @returns {Promise<number>}
 */
export async function typesPull({ flags, env = process.env, cwd = process.cwd(), fetch: fetchImpl = fetch, log = console.log, error = console.error }) {
  try {
    const out = resolve(cwd, typeof flags.out === "string" ? flags.out : DEFAULT_OUT);
    const base = checkBaseUrl(typeof flags.url === "string" ? flags.url : env.POLYNOVEA_CMS_URL || "http://localhost:3000");
    const token = readToken({ flags, env, cwd });
    const remote = await fetchTypes({ base, token, fetchImpl });
    const models = modelHashes(remote).size;

    if (flags.check) {
      let local;
      try { local = normalise(readFileSync(out, "utf8")); } catch {
        error(`types: ${out} does not exist. Run \`polynovea-cms types pull\` to create it.`);
        return 1;
      }
      if (local === remote) {
        log(`types: ${out} is up to date (${models} model${models === 1 ? "" : "s"}).`);
        return 0;
      }
      error([`types: ${out} is out of date:`, ...describeDrift(local, remote), "Run `polynovea-cms types pull` and commit the result."].join("\n"));
      return 1;
    }

    try { if (statSync(out).isDirectory()) throw new UsageError(`${out} is a directory; pass a file path with --out`); } catch (e) { if (e instanceof UsageError) throw e; }
    writeFileSync(out, remote);
    log(`types: wrote ${out} (${models} model${models === 1 ? "" : "s"}, schema ${remote.slice(16, 28)}).`);
    return 0;
  } catch (e) {
    error(`types: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
