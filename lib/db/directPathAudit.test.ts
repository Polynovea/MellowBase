import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard: code that changes data in a transaction writes its audit events with
// recordPlatformEvent(trx, ...) inside that transaction, never through logPlatformEvent, which runs
// on its own connection, outside the change's transaction, and could record a change that was
// rolled back (or lose one that committed).

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

describe("audit events in transactions", () => {
  it("no module that opens a transaction calls logPlatformEvent", () => {
    const offenders = files
      .filter(({ file }) => file !== "lib/platform/audit.ts")
      .filter(({ text }) => /\bwithTransaction\(/.test(text) && /\blogPlatformEvent\s*\(/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("no *.postgres.ts data module imports logPlatformEvent", () => {
    const offenders = files
      .filter(({ file }) => file.endsWith(".postgres.ts"))
      .filter(({ text }) => /import\s*{[^}]*\blogPlatformEvent\b[^}]*}\s*from\s*"@\/lib\/platform\/audit"/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
