import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as release from "./build-and-sign.mjs";

const parseArgs = release.parseArgs as (argv: string[]) => Record<string, unknown>;
const TOOLS = release.TOOLS as Record<string, string>;

const base = ["--image", "ghcr.io/polynovea/cms", "--version", "0.4.0", "--key", "/secure/release.key"];

describe("release script options", () => {
  it("defaults to both architectures, no transparency log, clean tree required", () => {
    expect(parseArgs(base)).toMatchObject({ image: "ghcr.io/polynovea/cms", version: "0.4.0", platforms: ["linux/amd64", "linux/arm64"], tlog: false, allowDirty: false });
  });

  it("accepts a local test registry with a port", () => {
    expect(parseArgs(["--image", "localhost:35000/polynovea-cms", ...base.slice(2)]).image).toBe("localhost:35000/polynovea-cms");
  });

  it.each([
    ["an image with a tag", ["--image", "ghcr.io/polynovea/cms:latest"]],
    ["an image with a digest", ["--image", "ghcr.io/polynovea/cms@sha256:" + "a".repeat(64)]],
    ["an image without a registry path", ["--image", "cms"]],
    ["a version that is not semver", ["--version", "latest"]],
    ["an unsupported platform", ["--platforms", "linux/s390x"]],
  ])("refuses %s", (_label, override) => {
    const args = [...base];
    const at = args.indexOf(override[0]);
    if (at >= 0) args.splice(at, 2, ...override);
    else args.push(...override);
    expect(() => parseArgs(args)).toThrow();
  });

  it("requires a key and refuses unknown options", () => {
    expect(() => parseArgs(base.slice(0, 4))).toThrow(/--key/);
    expect(() => parseArgs([...base, "--keyless"])).toThrow(/Unknown option/);
  });

  it("gives the signing password and the key file only to signing steps", () => {
    const toolArgs = release.toolArgs as (image: string, args: string[], opts?: Record<string, string>) => string[];
    const syft = toolArgs(TOOLS.syft, ["scan", "registry:x"], { out: "/out-dir" });
    const verify = toolArgs(TOOLS.cosign, ["verify", "--key", "/out/cosign.pub", "x"], { out: "/out-dir" });
    const sign = toolArgs(TOOLS.cosign, ["sign", "--key", release.KEY_IN_CONTAINER as string, "x"], { keyFile: "/secure/polynovea-release.key" });
    for (const args of [syft, verify]) {
      expect(args).not.toContain("COSIGN_PASSWORD");
      expect(args.join(" ")).not.toMatch(/\.key|\/keys/);
    }
    expect(sign).toContain("COSIGN_PASSWORD");
    // Exactly the key file, read-only; never its folder.
    expect(sign).toContain(`/secure/polynovea-release.key:${release.KEY_IN_CONTAINER}:ro`);
    expect(sign.join(" ")).not.toMatch(/\/secure:/);
    // The password travels by name only, never as a value on the command line.
    expect(sign.some((arg) => arg.startsWith("COSIGN_PASSWORD="))).toBe(false);
  });

  it("tags the signed manifest unchanged, never a new wrapping index (regression from the review re-test)", () => {
    const tagArgs = release.tagArgs as (tag: string, ref: string) => string[];
    const ref = `localhost:35000/polynovea-cms@sha256:${"a".repeat(64)}`;
    const args = tagArgs("localhost:35000/polynovea-cms:0.4.0", ref);
    expect(args.slice(0, 3)).toEqual(["buildx", "imagetools", "create"]);
    expect(args).toContain("--prefer-index=false");
    expect(args.at(-1)).toBe(ref);
    expect(args[args.indexOf("--tag") + 1]).toBe("localhost:35000/polynovea-cms:0.4.0");
  });

  it("runs syft, cosign and the release builder from images pinned by digest", () => {
    for (const image of Object.values(TOOLS)) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect((release.BUILDER as { image: string }).image).toMatch(/^moby\/buildkit:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });
});

describe("pinned base images", () => {
  const root = path.resolve(__dirname, "..", "..");

  it("pins every FROM image in the Dockerfile by digest", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const nodeImage = /ARG NODE_IMAGE=(\S+)/.exec(dockerfile)?.[1] ?? "";
    expect(nodeImage).toMatch(/^node:24[\w.-]*@sha256:[0-9a-f]{64}$/);
    for (const line of dockerfile.split(/\r?\n/).filter((l) => /^FROM /.test(l))) {
      expect(line).toMatch(/\$\{NODE_IMAGE\}/);
    }
  });

  it("pins Caddy by digest in compose and the VM image", () => {
    const compose = readFileSync(path.join(root, "docker/compose.yaml"), "utf8");
    const packer = readFileSync(path.join(root, "release/packer/variables.pkr.hcl"), "utf8");
    const caddy = /image: (caddy:\S+)/.exec(compose)?.[1];
    expect(caddy).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(packer).toContain(caddy);
  });
});

describe("release.json upgrade fields (System page and upgrade agent)", () => {
  const upgradeFields = release.upgradeFields as (options: { rollback: string; changelog?: string }, out: string) => Record<string, unknown>;

  it("defaults to restore and accepts only compatible or restore", () => {
    expect(parseArgs(base).rollback).toBe("restore");
    expect(parseArgs([...base, "--rollback", "compatible"]).rollback).toBe("compatible");
    expect(() => parseArgs([...base, "--rollback", "yes"])).toThrow(/--rollback/);
  });

  it("copies the changelog next to release.json and records its SHA-256", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-fields-"));
    try {
      const source = path.join(dir, "notes.md");
      writeFileSync(source, "## 0.4.1\n- Fixes.\n");
      const out = path.join(dir, "out");
      mkdirSync(out);
      const fields = upgradeFields({ rollback: "compatible", changelog: source }, out);
      const copied = readFileSync(path.join(out, "CHANGELOG.md"));
      expect(fields).toEqual({ rollback: "compatible", changelog: { file: "CHANGELOG.md", sha256: createHash("sha256").update(copied).digest("hex") } });
      expect(upgradeFields({ rollback: "restore" }, out)).toEqual({ rollback: "restore" });
      writeFileSync(source, "x".repeat(256 * 1024 + 1));
      expect(() => upgradeFields({ rollback: "restore", changelog: source }, out)).toThrow(/256 KB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
