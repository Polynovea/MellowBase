import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain-Node release script without type declarations
import { parseArgs, TOOLS } from "./build-and-sign.mjs";

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

  it("runs syft and cosign from images pinned by digest", () => {
    for (const image of Object.values(TOOLS) as string[]) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
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
    const compose = readFileSync(path.join(root, "deploy/docker/compose.yaml"), "utf8");
    const packer = readFileSync(path.join(root, "deploy/packer/variables.pkr.hcl"), "utf8");
    const caddy = /image: (caddy:\S+)/.exec(compose)?.[1];
    expect(caddy).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(packer).toContain(caddy);
  });
});
