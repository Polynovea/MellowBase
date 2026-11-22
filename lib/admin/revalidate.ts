const REVALIDATE_TIMEOUT_MS = 5_000;

export type RevalidateOutcome =
  | { status: "skipped"; reason: "not_configured" }
  | { status: "ok" }
  | { status: "failed"; error: string };

/**
 * Asks the website to revalidate its blog cache. Content saves never fail because of this, but a failure
 * is logged and returned instead of being swallowed, and the request cannot hang the save.
 */
export async function revalidateWebsiteBlog(slug?: string): Promise<RevalidateOutcome> {
  const websiteUrl = process.env.WEBSITE_URL;
  const secret = process.env.WEBSITE_REVALIDATE_SECRET;
  if (!websiteUrl || !secret) return { status: "skipped", reason: "not_configured" };

  try {
    const response = await fetch(new URL("/api/revalidate", websiteUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(REVALIDATE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = `Website revalidation returned HTTP ${response.status}`;
      console.warn("[revalidate] %s", error, { slug });
      return { status: "failed", error };
    }
    return { status: "ok" };
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError" ? `Website revalidation timed out after ${REVALIDATE_TIMEOUT_MS} ms` : "Website revalidation request failed";
    console.warn("[revalidate] %s", message, { slug, error });
    return { status: "failed", error: message };
  }
}
