/** Browser side of the owner step's API: same-origin JSON calls, the setup cookie sent automatically. */

export interface OwnerSummary {
  steps: Record<"account" | "authenticator" | "passkey" | "recovery" | "organisation" | "keys", boolean>;
  email: string | null;
  displayName: string | null;
  organisation: { organisationName: string; workspaceName: string; starterContent: boolean } | null;
  temporaryRoute: boolean | null;
  temporaryRouteWarning: string | null;
}

export class OwnerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "OwnerApiError";
  }

  /** The setup session is gone (expired, taken over, or never started): back to the code page. */
  get needsSetupCode(): boolean {
    return this.status === 401;
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OwnerApiError("The server could not be reached. Check your connection and try again.", 0, null);
  }
  const payload = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: string | null; code?: string } | null;
  if (!response.ok || !payload?.success) {
    throw new OwnerApiError(payload?.error || "Something went wrong. Try again.", response.status, payload?.code ?? null);
  }
  return payload.data as T;
}

export const ownerApi = {
  summary: () => call<OwnerSummary>("GET", "/api/setup/owner"),
  post: <T>(action: string, body: unknown = {}) => call<T>("POST", `/api/setup/owner/${action}`, body),
};
