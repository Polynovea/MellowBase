import { describe, expect, it } from "vitest";
import { maxUploadBytes, parseDeclaredSize, workspaceQuotaBytes } from "./uploadLimits";

describe("upload limits", () => {
  it("allows larger video than images", () => {
    expect(maxUploadBytes("video/mp4")).toBeGreaterThan(maxUploadBytes("image/png"));
  });

  it.each([[1, true], [10 * 1024 * 1024, true], ["2048", true]])("accepts a declared image size of %s", (size, ok) => {
    expect(parseDeclaredSize(size, "image/png").ok).toBe(ok);
  });

  it.each([[0, 400], [-5, 400], [1.5, 400], ["12abc", 400], [undefined, 400], [10 * 1024 * 1024 + 1, 413]])("rejects a declared image size of %s", (size, status) => {
    const result = parseDeclaredSize(size, "image/png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(status);
  });

  it("accepts a 150 MB video", () => {
    expect(parseDeclaredSize(150 * 1024 * 1024, "video/mp4").ok).toBe(true);
  });
});

describe("workspaceQuotaBytes", () => {
  it("is unlimited when unset", () => expect(workspaceQuotaBytes({})).toBeNull());
  it("reads a byte count", () => expect(workspaceQuotaBytes({ MEDIA_WORKSPACE_QUOTA_BYTES: "5368709120" })).toBe(5368709120));
  it("rejects a malformed value instead of silently ignoring it", () => expect(() => workspaceQuotaBytes({ MEDIA_WORKSPACE_QUOTA_BYTES: "5GB" })).toThrow());
});
