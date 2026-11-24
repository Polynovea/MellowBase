/**
 * What the setup pages tell the admin about the CMS's address (POLYNOVEA_PUBLIC_URL): passkeys and
 * sign-in belong to that exact address (scheme, host and port), so the page shows it, the SSH tunnel
 * command that reaches it, and whether the browser is on it.
 */
export interface ExpectedAddress {
  origin: string;
  /** The ssh -L command for a loopback address (an SSH tunnel), else null. */
  tunnelCommand: string | null;
}

/** The configured address as an origin, or null when unset or not a web address. */
export function configuredOrigin(raw: string | undefined): string | null {
  try {
    const url = raw?.trim() ? new URL(raw.trim()) : null;
    return url && (url.protocol === "http:" || url.protocol === "https:") ? url.origin : null;
  } catch {
    return null;
  }
}

export function expectedAddress(origin: string): ExpectedAddress {
  const url = new URL(origin);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return { origin: url.origin, tunnelCommand: loopback ? `ssh -L ${port}:127.0.0.1:${port} you@your-server` : null };
}

/** True when the browser's origin is not the configured one (unknown until the page runs). */
export function addressMismatch(expected: string, actual: string | null): boolean {
  return actual !== null && actual !== new URL(expected).origin;
}
