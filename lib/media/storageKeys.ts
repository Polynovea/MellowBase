// Every object this CMS writes lives under "<workspaceId>/...". A caller may only address keys under its
// own workspace prefix, and the key must be a plain relative path so it cannot be re-rooted by the
// storage backend (no "..", ".", empty segments, backslashes, control characters or leading slash).

const MAX_KEY_LENGTH = 1024;

export function isWorkspaceStorageKey(workspaceId: string, key: unknown): key is string {
  if (typeof key !== "string" || !workspaceId || key.length > MAX_KEY_LENGTH) return false;
  if (!key.startsWith(`${workspaceId}/`)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(key)) return false;
  const segments = key.split("/");
  return segments.length >= 2 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
