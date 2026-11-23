export const RDS_CA_BUNDLE_ID: "aws-rds-global-1";
export const PUBLIC_CA_BUNDLE_ID: "digicert-microsoft-1";
export const RDS_BUNDLE_SHA256: string | null;
export const RDS_BUNDLE_RELATIVE_PATH: string;

export class CaBundleError extends Error {
  readonly missing: "rds" | "public";
  constructor(message: string, missing: "rds" | "public");
}

export interface TrustedRoots {
  id: typeof RDS_CA_BUNDLE_ID | typeof PUBLIC_CA_BUNDLE_ID;
  ca: string[];
}

export function isRdsHostname(hostname: string): boolean;
export function bundleSha256(text: string): string;
export function publicRoots(store?: readonly string[]): string[];
export function rdsRoots(options?: { root?: string; expectedSha256?: string | null }): string[];
export function rootsForHost(hostname: string): TrustedRoots;
export function certificateAuthoritiesFor(caBundleId: string | null): string[] | null;
