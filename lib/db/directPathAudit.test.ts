import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard for phase 1: an area on the direct path writes its audit events with
// recordPlatformEvent(trx, ...) inside the transaction that made the change, never through
// logPlatformEvent (which follows the `platform` switch, may hit the other database while the switch
// exists, and runs outside the change's transaction). Shared code of a moved area that is not in a
// transaction uses logPlatformEventFor(area, ...).

const root = path.resolve(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(path.join(root, "lib")).map((file) => ({
  file: path.relative(root, file).replace(/\\/g, "/"),
  text: readFileSync(file, "utf8"),
}));
const callsLogPlatformEvent = /\blogPlatformEvent\s*\(/;

describe("direct-path audit events", () => {
  it("no *.postgres.ts implementation calls logPlatformEvent", () => {
    const offenders = files
      .filter(({ file }) => file.endsWith(".postgres.ts"))
      .filter(({ text }) => callsLogPlatformEvent.test(text) || /import\s*{[^}]*\blogPlatformEvent\b[^}]*}\s*from\s*"@\/lib\/platform\/audit"/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("no area dispatcher (a file that switches on usesDirectPostgres) calls logPlatformEvent", () => {
    const offenders = files
      .filter(({ file }) => file !== "lib/platform/audit.ts" && file !== "lib/db/backend.ts")
      .filter(({ text }) => /\busesDirectPostgres\(/.test(text) && callsLogPlatformEvent.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("every direct implementation that writes rows also records its audit events in a transaction", () => {
    const writers = files.filter(({ file, text }) =>
      file.endsWith(".postgres.ts") && file !== "lib/platform/audit.postgres.ts" && /\.(insertInto|updateTable|deleteFrom)\(/.test(text));
    for (const { file, text } of writers) {
      // Writers either record audit events in the transaction or write nothing that is audited on the
      // Supabase path (checked by comparing with the area's .supabase.ts file).
      const supabaseFile = files.find((candidate) => candidate.file === file.replace(/\.postgres\.ts$/, ".supabase.ts"));
      const supabaseAudits = supabaseFile ? callsLogPlatformEvent.test(supabaseFile.text) : false;
      if (supabaseAudits) expect({ file, records: /\brecordPlatformEvent\(\s*trx\b/.test(text) }).toEqual({ file, records: true });
    }
  });
});
