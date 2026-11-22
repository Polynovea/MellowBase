import { describe, expect, it } from "vitest";
import { assertCanonicalMediaFilename, assertMediaSignature, canonicalMediaExtension } from "@/lib/media/uploadValidation";

// Exercises the production upload validation used by /api/upload, /api/upload/sas and the asset registry.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

describe("media upload validation", () => {
  it.each([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["image/gif", "gif"], ["video/mp4", "mp4"]])("maps %s to a canonical extension", (type, ext) => {
    expect(canonicalMediaExtension(type)).toBe(ext);
  });

  it("has no extension for unsupported types", () => {
    expect(canonicalMediaExtension("application/x-msdownload")).toBeNull();
    expect(canonicalMediaExtension("image/svg+xml")).toBeNull();
  });

  it.each([["cover.png", "image/png"], ["photo.jpeg", "image/jpeg"], ["clip.MP4", "video/mp4"]])("accepts %s declared as %s", (name, type) => {
    expect(() => assertCanonicalMediaFilename(name, type)).not.toThrow();
  });

  it.each([["cover.php", "image/png"], ["cover.png.exe", "image/png"], ["cover.svg", "image/svg+xml"], ["cover.jpg", "image/png"]])("rejects %s declared as %s", (name, type) => {
    expect(() => assertCanonicalMediaFilename(name, type)).toThrow();
  });

  it("accepts content whose bytes match the declared type", () => {
    expect(() => assertMediaSignature(PNG, "image/png")).not.toThrow();
    expect(() => assertMediaSignature(JPEG, "image/jpeg")).not.toThrow();
  });

  it("rejects content whose bytes do not match the declared type", () => {
    expect(() => assertMediaSignature(JPEG, "image/png")).toThrow();
    expect(() => assertMediaSignature(Buffer.from("<?php system($_GET[0]); ?>"), "image/png")).toThrow();
  });
});
