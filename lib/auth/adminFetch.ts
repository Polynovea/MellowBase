"use client";

/**
 * The admin UI's API client: one window.fetch wrapper, installed once by ProtectedRoute, that
 * attaches the credential each provider needs to same-origin /api/ calls.
 *
 * - Supabase: the GoTrue access token as `Authorization: Bearer`.
 * - Built-in: nothing for the credential (the browser sends the HttpOnly session cookie itself),
 *   plus the session-bound CSRF token on state-changing requests; MFA_REQUIRED sends the user to
 *   set up two-step sign-in.
 * - Both: a request refused with STEP_UP_REQUIRED asks the user to confirm who they are (sign in
 *   again) and is retried once afterwards, with the new session's credential.
 */
import { browserAuthProvider } from "@/lib/auth/settings";
import { getSupabaseBrowserIdentityProvider } from "@/lib/auth/supabaseProvider";

export const CSRF_HEADER = "x-polynovea-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const INSTALLED = Symbol.for("polynovea.adminFetch");

let csrfToken: string | null = null;
let csrfPending: Promise<string | null> | null = null;

/** Forget the CSRF token (after sign-in, sign-out or a CSRF refusal). */
export function resetCsrfToken(): void {
  csrfToken = null;
  csrfPending = null;
}

async function loadCsrfToken(nativeFetch: typeof fetch): Promise<string | null> {
  if (csrfToken) return csrfToken;
  csrfPending ??= nativeFetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => (response.ok ? ((await response.json())?.data?.token as string | undefined) ?? null : null))
    .catch(() => null)
    .then((token) => {
      csrfToken = token;
      csrfPending = null;
      return token;
    });
  return csrfPending;
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;

/** The admin shell registers the dialog that asks the user to re-authenticate. */
export function setStepUpHandler(handler: StepUpHandler | null): void {
  stepUpHandler = handler;
}

function isCmsApi(url: string): boolean {
  return url.startsWith("/api/") || url.startsWith(`${window.location.origin}/api/`);
}

async function securityCode(response: Response): Promise<string | null> {
  if (response.status !== 403) return null;
  try {
    return ((await response.clone().json()) as { code?: string })?.code ?? null;
  } catch {
    return null;
  }
}

export function installAdminFetch(): void {
  const holder = window as unknown as Record<symbol, boolean>;
  if (holder[INSTALLED]) return;
  holder[INSTALLED] = true;
  const nativeFetch = window.fetch.bind(window);
  const provider = browserAuthProvider();

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (!isCmsApi(url) || url.includes("/api/auth/")) return nativeFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    // A Request body can be read once; keep a pristine copy for the retry after a step-up.
    const original = input instanceof Request ? input.clone() : null;
    const send = async (afterStepUp = false): Promise<Response> => {
      const source = original ? original.clone() : null;
      const headers = new Headers(source ? source.headers : init?.headers);
      if (provider === "supabase") {
        // After a step-up the page's own header still carries the old token; use the new session's.
        if (afterStepUp || !headers.has("authorization")) {
          const { session } = await getSupabaseBrowserIdentityProvider().getSession();
          if (session?.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);
        }
      } else {
        // The cookie is the credential; the session marker or a stale bearer header never leaves the page.
        headers.delete("authorization");
        if (!SAFE_METHODS.has(method)) {
          const token = await loadCsrfToken(nativeFetch);
          if (token) headers.set(CSRF_HEADER, token);
        }
      }
      if (source) return nativeFetch(new Request(source, { headers, credentials: "same-origin" }));
      return nativeFetch(input, { ...init, headers, credentials: "same-origin" });
    };

    let response = await send();
    const code = await securityCode(response);
    if (code === "CSRF_FAILED" && provider === "builtin") {
      resetCsrfToken();
      response = await send();
    } else if (code === "STEP_UP_REQUIRED" && stepUpHandler && (await stepUpHandler())) {
      resetCsrfToken();
      response = await send(true);
    } else if (code === "MFA_REQUIRED" && provider === "builtin" && !window.location.pathname.startsWith("/admin/security")) {
      window.location.assign("/admin/security?setup=mfa");
    }
    return response;
  };
}

/** Asks the user to confirm it's them (for Better Auth calls that need a fresh session). */
export async function requestStepUp(): Promise<boolean> {
  return stepUpHandler ? stepUpHandler() : false;
}
