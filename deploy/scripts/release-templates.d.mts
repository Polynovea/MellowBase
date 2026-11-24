export const RELEASE_FILE: string;
export const CFN: string;
export const BOOTSTRAP: string;
export const CMS_IMAGE: RegExp;
export const CADDY_IMAGE: RegExp;
export const AMI: RegExp;
export const GALLERY_IMAGE: RegExp;
export const AWS_REGIONS: string[];
export interface Release {
  release: boolean;
  cmsImage: string;
  caddyImage: string;
  aws?: { amis?: Record<string, Partial<Record<"arm64" | "amd64", string>>> };
  azure?: { galleryImages?: Partial<Record<"x64" | "arm64", string>> };
}
export function loadRelease(text: string): Release;
export function renderCfn(cfn: string, release: Release): string;
export interface SignedRelease { schema: number; image?: string; digest?: string; ref?: string; publicKeySha256?: string }
export function releaseGaps(release: Release, bootstrap: string, cfn: string, arm: unknown, signed?: SignedRelease | null): string[];
export function signedReleaseGaps(release: Release, bootstrap: string, signed: SignedRelease): string[];
