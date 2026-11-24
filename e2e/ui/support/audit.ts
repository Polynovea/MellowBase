import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The per-screen checks of the UI audit (docs/ui-audit/report.md):
 * - screenshots at 390 px and 1440 px, light and dark, in docs/ui-audit/screenshots/<screen>-<width>-<theme>.jpg;
 * - axe-core (WCAG 2.2 A/AA rules) on each of those four views; serious and critical findings fail;
 * - no horizontal scroll at 390 px, and what sticks out past the right edge;
 * - the page title;
 * - every same-site link on the screen, collected for the broken-link check.
 * Raw results go to test-results/ui/audit/<screen>.json; scripts/ui-test/summarise.mjs turns them
 * into docs/ui-audit/automated-checks.md.
 */

export const SCREENSHOT_DIR = path.resolve("docs/ui-audit/screenshots");
export const RESULTS_DIR = path.resolve("test-results/ui/audit");
export const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const;
export const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export interface AxeFinding { id: string; impact: string | null; help: string; helpUrl: string; nodes: Array<{ target: string; html: string; summary: string }> }
export interface ViewResult { width: number; theme: Theme; screenshot: string; horizontalScroll: boolean; sticksOut: string[]; axe: AxeFinding[] }
export interface ScreenResult { screen: string; url: string; title: string; links: string[]; views: ViewResult[] }

/** Applies a theme the way the app's theme toggle does, without a reload (wizard steps keep their state). */
export async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((value) => {
    try { window.localStorage.setItem("polynovea-cms-theme", value); } catch { /* storage blocked */ }
    const root = document.documentElement;
    root.dataset.themePreference = value;
    root.dataset.theme = value;
    root.classList.toggle("dark", value === "dark");
    root.style.colorScheme = value;
  }, theme);
}

/** Waits until nothing on the page is spinning or loading, so screenshots and axe see the settled screen. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.locator(".animate-spin").first()).toBeHidden({ timeout: 20_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
}

async function runAxe(page: Page): Promise<AxeFinding[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(axeSource);
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] });
    return (result.violations as Array<{ id: string; impact: string | null; help: string; helpUrl: string; nodes: Array<{ target: unknown[]; html: string; failureSummary?: string }> }>).map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodes: violation.nodes.slice(0, 8).map((node) => ({ target: node.target.map(String).join(" "), html: node.html.slice(0, 200), summary: (node.failureSummary ?? "").slice(0, 300) })),
    }));
  });
}

async function overflow(page: Page): Promise<{ horizontalScroll: boolean; sticksOut: string[] }> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const horizontalScroll = doc.scrollWidth > doc.clientWidth + 1;
    const limit = window.innerWidth + 1;
    const scrollsSideways = (el: Element | null): boolean => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) return true;
      }
      return false;
    };
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
    };
    const sticksOut: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.right <= limit) continue;
      if (getComputedStyle(el).position === "fixed" || scrollsSideways(el.parentElement)) continue;
      // Report the outermost offender only.
      if (el.parentElement && el.parentElement.getBoundingClientRect().right > limit && !scrollsSideways(el.parentElement.parentElement)) continue;
      sticksOut.push(describe(el));
      if (sticksOut.length >= 10) break;
    }
    return { horizontalScroll, sticksOut };
  });
}

async function sameSiteLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const url = new URL(anchor.getAttribute("href")!, location.href);
      if (url.origin === location.origin && !url.pathname.startsWith("/api/auth")) out.add(url.pathname + url.search);
    }
    return [...out];
  });
}

/**
 * Screenshots and checks the screen the page is on now, in all four views, without navigating:
 * wizard steps hold state that a reload would lose. Leaves the page at 1440 px, dark.
 */
export async function auditScreen(page: Page, screen: string): Promise<ScreenResult> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  await settle(page);
  const result: ScreenResult = { screen, url: new URL(page.url()).pathname, title: await page.title(), links: await sameSiteLinks(page), views: [] };
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      await page.waitForTimeout(150);
      const file = `${screen}-${viewport.width}-${theme}.jpg`;
      const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 3000);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, file), type: "jpeg", quality: 70, fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height }, animations: "disabled", caret: "hide" });
      const { horizontalScroll, sticksOut } = viewport.width === 390 ? await overflow(page) : { horizontalScroll: false, sticksOut: [] };
      result.views.push({ width: viewport.width, theme, screenshot: `screenshots/${file}`, horizontalScroll, sticksOut, axe: await runAxe(page) });
    }
  }
  await page.setViewportSize(VIEWPORTS[1]);
  // Recorded only. The gates (no serious or critical axe finding, no sideways scroll at 390 px, a
  // named tab title) are one test at the end of 80-audit.spec.ts, so a finding never stops a flow.
  writeFileSync(path.join(RESULTS_DIR, `${screen}.json`), JSON.stringify(result, null, 2));
  return result;
}

/** The gate over every recorded screen: what auditScreen found, as a list of plain problems. */
export function auditProblems(results: ScreenResult[]): string[] {
  const problems: string[] = [];
  for (const result of results) {
    for (const view of result.views) {
      for (const finding of view.axe.filter((f) => f.impact === "serious" || f.impact === "critical")) {
        problems.push(`${result.screen} ${view.width}px ${view.theme}: ${finding.impact} ${finding.id} (${finding.nodes.map((node) => node.target).join(", ")})`);
      }
      if (view.width === 390 && view.horizontalScroll) problems.push(`${result.screen} ${view.theme}: scrolls sideways at 390 px (${view.sticksOut.join("; ")})`);
    }
    if (/^(Polynovea Admin|Polynovea CMS)?$/.test(result.title)) problems.push(`${result.screen}: the tab title does not name the screen ("${result.title}")`);
  }
  return problems;
}

/** Presses Tab until `target` has focus (at most `max` presses), then checks the focus is visible. */
export async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  // Fails at once (not after the test timeout) when the control isn't on the page at all.
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      await expectVisibleFocus(target);
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${target}`);
}

/** The focused element shows a focus ring: an outline, or a border or shadow that differs from its resting style. */
export async function expectVisibleFocus(target: Locator): Promise<void> {
  const visible = await target.evaluate((el) => {
    const focused = getComputedStyle(el);
    const ring = (s: CSSStyleDeclaration) => ({ outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` : "", border: s.borderColor, shadow: s.boxShadow });
    const now = ring(focused);
    if (now.outline) return true;
    const clone = el.cloneNode(false) as HTMLElement;
    clone.style.position = "absolute";
    clone.style.visibility = "hidden";
    el.parentElement?.appendChild(clone);
    const rest = ring(getComputedStyle(clone));
    clone.remove();
    return now.border !== rest.border || (now.shadow !== rest.shadow && now.shadow !== "none");
  });
  expect.soft(visible, `visible focus on ${target}`).toBe(true);
}
