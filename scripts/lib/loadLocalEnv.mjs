import { existsSync, readFileSync } from "node:fs";

/**
 * Fills unset environment variables from `.env.local`, when that file exists. The environment always
 * wins, and a missing file is not an error: certification and maintenance scripts run from the
 * process environment alone (as scripts/certify-all.mjs documents).
 */
export function loadLocalEnv(file = ".env.local") {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
