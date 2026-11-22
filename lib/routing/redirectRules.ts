// Pure redirect rules shared by both data paths (moved unchanged out of redirectService.ts). Each
// path supplies how to load the workspace's active redirects; the rules themselves are identical.
import { normalizePath } from "@/lib/routing/routePaths";
import type { BulkImportItem, BulkImportReport } from "@/lib/routing/redirectService";

export interface ValidImportItem {
  sourcePath: string;
  targetPath: string;
  statusCode: 301 | 302 | 307 | 308;
  locale: string | null;
  description: string | null;
}

/**
 * Loop Detection Algorithm (the database read is the caller's `loadActiveRedirects`):
 * Follows the redirect chain from targetPath up to maxHops (10).
 * If it circles back to sourcePath or forms a closed loop, returns isLoop = true.
 */
export async function detectRedirectLoopWith(
  loadActiveRedirects: () => Promise<Array<{ source_path: string; target_path: string }>>,
  sourcePath: string,
  targetPath: string,
): Promise<{ isLoop: boolean; loopPath?: string[]; error?: string }> {
  const normSource = normalizePath(sourcePath);
  if (!normSource.ok) return { isLoop: true, error: normSource.error };

  // If target is an external URL, no internal loop can happen
  if (targetPath.startsWith("http://") || targetPath.startsWith("https://")) {
    return { isLoop: false };
  }

  const normTarget = normalizePath(targetPath);
  if (!normTarget.ok) return { isLoop: true, error: normTarget.error };

  if (normSource.path === normTarget.path) {
    return {
      isLoop: true,
      loopPath: [normSource.path, normTarget.path],
      error: `Self-redirect loop: source and target are identical (${normSource.path})`,
    };
  }

  const data = await loadActiveRedirects();
  const redirectMap = new Map<string, string>();
  for (const r of (data ?? [])) {
    redirectMap.set(r.source_path, r.target_path);
  }

  // Simulate inserting this new rule
  redirectMap.set(normSource.path, normTarget.path);

  // Traverse chain from normSource
  const visited = new Set<string>();
  const chain: string[] = [normSource.path];
  let current: string | undefined = normSource.path;

  while (current && redirectMap.has(current)) {
    if (visited.has(current)) {
      return {
        isLoop: true,
        loopPath: [...chain, current],
        error: `Circular redirect loop detected: ${[...chain, current].join(" -> ")}`,
      };
    }
    visited.add(current);
    const next = redirectMap.get(current);
    if (!next || next.startsWith("http://") || next.startsWith("https://")) {
      break;
    }
    const normNext = normalizePath(next);
    if (!normNext.ok) break;
    chain.push(normNext.path);
    current = normNext.path;

    if (chain.length > 12) {
      return {
        isLoop: true,
        loopPath: chain,
        error: "Redirect chain exceeds 10 hops",
      };
    }
  }

  return { isLoop: false };
}

/**
 * Bulk import validation: syntax, normalized paths, duplicate sources within the payload, and loops
 * against existing redirects. Fills the report's counts and errors and returns the valid rows.
 */
export async function validateImportItems(
  items: BulkImportItem[],
  report: BulkImportReport,
  detectLoop: (sourcePath: string, targetPath: string, locale?: string | null) => Promise<{ isLoop: boolean; error?: string }>,
): Promise<ValidImportItem[]> {
  const validItems: ValidImportItem[] = [];

  const seenSources = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const normSource = normalizePath(item.sourcePath);
    if (!normSource.ok) {
      report.errorCount++;
      report.errors.push({ row: i + 1, sourcePath: item.sourcePath, error: normSource.error });
      continue;
    }

    if (seenSources.has(normSource.path)) {
      report.errorCount++;
      report.errors.push({ row: i + 1, sourcePath: item.sourcePath, error: "Duplicate source path in import payload" });
      continue;
    }
    seenSources.add(normSource.path);

    const loopCheck = await detectLoop(normSource.path, item.targetPath, item.locale);
    if (loopCheck.isLoop) {
      report.errorCount++;
      report.errors.push({ row: i + 1, sourcePath: item.sourcePath, error: loopCheck.error || "Circular loop" });
      continue;
    }

    const code = Number(item.statusCode) || 301;
    const validCodes = [301, 302, 307, 308];
    const statusCode = (validCodes.includes(code) ? code : 301) as 301 | 302 | 307 | 308;

    validItems.push({
      sourcePath: normSource.path,
      targetPath: item.targetPath.trim(),
      statusCode,
      locale: item.locale || null,
      description: item.description?.trim() || null,
    });
    report.validCount++;
  }


  return validItems;
}
