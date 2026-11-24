import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4 security review: the items API treats "has a published version and is not archived" as live.
 * A release rollback that reverted entries to draft without clearing published_version_id would bring
 * content back. Today a rollback is only a PLAN (release_rollback_items is written when a release is
 * scheduled and read for display); nothing applies it to content_entries. This guard fails the day
 * code starts applying it, so that code is written (and tested) to clear published_version_id.
 */
function files(dir: string, ext: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name.startsWith(".") ? [] : files(path, ext);
    // Runtime code only: tests and certification scripts set up fixtures and read the plan.
    return ext.some((e) => name.endsWith(e)) && !name.includes(".test.") && !name.startsWith("certify") ? [path] : [];
  });
}

describe("release rollback never reverts entries without clearing their published version", () => {
  it("no code applies release_rollback_items to content_entries (rollback is a plan only)", () => {
    const root = process.cwd();
    const sources = [...files(join(root, "supabase", "migrations"), [".sql"]), ...files(join(root, "lib"), [".ts", ".mjs"]), ...files(join(root, "app"), [".ts", ".tsx"]), ...files(join(root, "scripts"), [".mjs"])];
    const appliers = sources.filter((path) => {
      const text = readFileSync(path, "utf8");
      return /release_rollback_items/.test(text) && /update\s+(public\.)?content_entries|updateTable\(\s*["']content_entries["']\s*\)/i.test(text)
        && /release_rollback_items[\s\S]{0,2000}(update\s+(public\.)?content_entries|updateTable\(\s*["']content_entries)/i.test(text);
    });
    expect(appliers.map((path) => path.slice(root.length + 1))).toEqual([]);
  });
});
