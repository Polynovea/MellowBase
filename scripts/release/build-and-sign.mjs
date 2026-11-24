#!/usr/bin/env node
/**
 * Builds, signs and records a Polynovea CMS release, on a local release machine. GitHub Actions is not
 * used (no organisation Actions minutes), so keyless signing (which needs Actions' identity) is not
 * used either: images are signed with a cosign key pair kept on the release machine.
 *
 *   COSIGN_PASSWORD=... node scripts/release/build-and-sign.mjs \
 *     --image ghcr.io/polynovea/cms --version 0.4.0 --key /secure/polynovea-release.key
 *
 * Options:
 *   --image <registry/name>   where the image is pushed (required)
 *   --version <semver>        release version (required); the release ID is <version>+<short commit>
 *   --key <path>              cosign private key (required); its .pub must sit next to it
 *   --platforms <list>        default linux/amd64,linux/arm64
 *   --out <dir>               default dist/release/<release ID>
 *   --tlog                    also record the signatures in Sigstore's public transparency log (Rekor).
 *                             Off by default: nothing about the release leaves the machine except the push.
 *   --docker-config <dir>     a Docker config folder with the registry login, for syft and cosign
 *                             (they cannot use Docker Desktop's credential helper). Omit for a registry
 *                             that needs no login.
 *   --allow-dirty             build even with uncommitted changes (tests only; the release ID says so)
 *
 * What it does, in order, stopping at the first failure:
 *   1. checks the working tree is clean and the key pair is present (never reads or prints the key);
 *   2. builds every platform and pushes once, recording the image digest (index) and each platform's;
 *   3. makes an SPDX SBOM per platform with syft;
 *   4. signs the index and every platform manifest with cosign (--recursive);
 *   5. attaches each SBOM to its platform manifest as a signed SPDX attestation;
 *   6. writes release.json (digests, SBOM hashes, tool and base image digests) and signs it as a blob;
 *   7. verifies everything again with the public key alone, as an installer or upgrade would;
 *   8. only then tags <image>:<version> to that digest (the build pushed by digest, with no tag).
 *
 * syft and cosign run from their images, pinned by digest, so the release machine needs only Docker.
 * Only the three signing steps (sign, attest, sign-blob) see the private key (that one file, read-only)
 * and COSIGN_PASSWORD; syft and every verify step see neither.
 * The tool containers use host networking so a registry on this machine's loopback works the same as a
 * remote one.
 *
 * KEY HANDLING (read docs/self-hosting/release-signing.md before the first release):
 * - Generate the pair once, on the release machine: `cosign generate-key-pair` (encrypted with a strong
 *   password). Never commit it, never copy it to a server, a CI system or a chat.
 * - Keep the private key on an encrypted disk, readable only by the release user; keep an offline,
 *   encrypted backup. The password lives in a password manager, and is given to this script only
 *   through COSIGN_PASSWORD in the environment of the one command.
 * - Publish the public key (the release folder's cosign.pub, the website, the README). Rotating it
 *   means publishing the new public key in a release signed by the old one.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The release builder: BuildKit in its own container (Docker's built-in builder cannot push by digest).
 * Host networking, so a registry on this machine's loopback works like a remote one. Kept between
 * releases for its cache; `docker buildx rm polynovea-release` removes it and its cache.
 */
export const BUILDER = Object.freeze({
  name: "polynovea-release",
  image: "moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe",
});

export const TOOLS = Object.freeze({
  syft: "anchore/syft:v1.33.0@sha256:f94e5d9fce1f2278491a8e3a63bd5f6ddb81fdfdbb8bf7a1637565c1d5344357",
  cosign: "ghcr.io/sigstore/cosign/cosign:v2.6.1@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037",
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function parseArgs(argv) {
  const options = { platforms: "linux/amd64,linux/arm64", tlog: false, allowDirty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--image": options.image = next(); break;
      case "--version": options.version = next(); break;
      case "--key": options.key = next(); break;
      case "--platforms": options.platforms = next(); break;
      case "--out": options.out = next(); break;
      case "--tlog": options.tlog = true; break;
      case "--docker-config": options.dockerConfig = next(); break;
      case "--allow-dirty": options.allowDirty = true; break;
      default: throw new Error(`Unknown option ${arg}`);
    }
  }
  if (!options.image || !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:\d+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$/.test(options.image)) {
    throw new Error("--image must be registry/name in lowercase, without a tag or digest");
  }
  if (!options.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(options.version)) throw new Error("--version must be a version such as 0.4.0 or 0.4.0-rc.1");
  if (!options.key) throw new Error("--key is required");
  const platforms = options.platforms.split(",").map((p) => p.trim()).filter(Boolean);
  if (platforms.length === 0 || !platforms.every((p) => /^linux\/(amd64|arm64)$/.test(p))) throw new Error("--platforms takes linux/amd64 and/or linux/arm64");
  options.platforms = platforms;
  return options;
}

// The only two programs this script runs: docker and git, named literally, always with an argument
// list and never through a shell.
const spawnOptions = (capture) => ({
  cwd: ROOT,
  stdio: capture ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"],
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  shell: false,
});

function settle(program, args, result, capture) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args[0] ?? ""} ${args[1] ?? ""} failed (exit ${result.status})`);
  return capture ? result.stdout.trim() : "";
}

function run(program, args, { capture = false } = {}) {
  if (program === "docker") return settle("docker", args, spawnSync("docker", args, spawnOptions(capture)), capture);
  if (program === "git") return settle("git", args, spawnSync("git", args, spawnOptions(capture)), capture);
  throw new Error(`Unexpected program ${program}`);
}

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const step = (message) => console.log(`\n== ${message}`);

let dockerConfigDir = null;

/** A tool container: host network, the output folder and the key folder mounted, COSIGN_PASSWORD passed by name only. */
/** Where the private key appears inside a signing container (read-only, the one file only). */
export const KEY_IN_CONTAINER = "/keys/release.key";

/**
 * The `docker run` arguments for one tool container. Only a signing step (keyFile given) gets the
 * private key, mounted as that single file read-only, and COSIGN_PASSWORD (passed by name, never its
 * value on a command line). syft and the verify steps get neither.
 */
export function toolArgs(image, args, { out, keyFile, dockerConfig } = {}) {
  const docker = ["run", "--rm", "--network", "host"];
  if (keyFile) docker.push("-e", "COSIGN_PASSWORD", "-v", `${keyFile}:${KEY_IN_CONTAINER}:ro`);
  if (out) docker.push("-v", `${out}:/out`);
  if (dockerConfig) docker.push("-e", "DOCKER_CONFIG=/docker-config", "-v", `${dockerConfig}:/docker-config:ro`);
  docker.push(image, ...args);
  return docker;
}

function tool(image, args, { out, keyFile, capture = false } = {}) {
  return run("docker", toolArgs(image, args, { out, keyFile, dockerConfig: dockerConfigDir }), { capture });
}

function ensureBuilder() {
  try {
    run("docker", ["buildx", "inspect", BUILDER.name], { capture: true });
  } catch {
    run("docker", ["buildx", "create", "--name", BUILDER.name, "--driver", "docker-container",
      "--driver-opt", "network=host", "--driver-opt", `image=${BUILDER.image}`]);
  }
}

function baseImages() {
  const text = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  return [...new Set([...text.matchAll(/([a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64})/g)].map((m) => m[1]))];
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (process.env.COSIGN_PASSWORD === undefined) throw new Error("Set COSIGN_PASSWORD in this command's environment (from your password manager).");

  step("1. Checks");
  if (options.dockerConfig) {
    dockerConfigDir = path.resolve(options.dockerConfig);
    if (!existsSync(path.join(dockerConfigDir, "config.json"))) throw new Error("--docker-config must be a folder holding config.json");
  }
  const keyFile = path.resolve(options.key);
  const pubFile = keyFile.replace(/\.key$/, ".pub");
  if (!existsSync(keyFile) || !existsSync(pubFile) || keyFile === pubFile) throw new Error("The key pair was not found: --key must name <name>.key with <name>.pub beside it.");
  const pubName = path.basename(pubFile);
  const revision = run("git", ["rev-parse", "HEAD"], { capture: true });
  const dirty = run("git", ["status", "--porcelain"], { capture: true }) !== "";
  if (dirty && !options.allowDirty) throw new Error("The working tree has uncommitted changes. Commit them, or pass --allow-dirty for a test build.");
  const releaseId = `${options.version}+${revision.slice(0, 7)}${dirty ? ".dirty" : ""}`;
  const out = path.resolve(options.out ?? path.join(ROOT, "dist", "release", releaseId.replace(/\+/g, "_")));
  mkdirSync(out, { recursive: true });
  console.log(`release ${releaseId} -> ${options.image}, platforms ${options.platforms.join(", ")}`);

  step("2. Build and push");
  ensureBuilder();
  const metadataFile = path.join(out, "build-metadata.json");
  const started = Date.now();
  run("docker", [
    "buildx", "build",
    "--builder", BUILDER.name,
    "--platform", options.platforms.join(","),
    "--build-arg", `POLYNOVEA_RELEASE_ID=${releaseId}`,
    "--build-arg", `POLYNOVEA_VERSION=${options.version}`,
    "--build-arg", `POLYNOVEA_REVISION=${revision}`,
    "--provenance=false",
    "--metadata-file", metadataFile,
    // Pushed by digest only: no tag exists until every signature has verified (step 8).
    "--output", `type=image,name=${options.image},push-by-digest=true,name-canonical=true,push=true`,
    ".",
  ]);
  const buildSeconds = Math.round((Date.now() - started) / 1000);
  const digest = JSON.parse(readFileSync(metadataFile, "utf8"))["containerimage.digest"];
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new Error("The build did not report an image digest");
  const ref = `${options.image}@${digest}`;
  const index = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", ref, "--raw"], { capture: true }));
  const platforms = {};
  for (const manifest of index.manifests ?? [{ digest, platform: { os: "linux", architecture: options.platforms[0].split("/")[1] } }]) {
    if (manifest.platform?.os === "linux") platforms[manifest.platform.architecture] = manifest.digest;
  }
  console.log(`pushed ${ref} in ${buildSeconds}s`);

  step("3. SBOM per platform (syft, SPDX JSON)");
  const sboms = {};
  for (const [arch, platformDigest] of Object.entries(platforms)) {
    const file = `sbom-${arch}.spdx.json`;
    tool(TOOLS.syft, ["scan", `registry:${options.image}@${platformDigest}`, "-o", `spdx-json=/out/${file}`, "-q"], { out });
    sboms[arch] = { file, sha256: sha256File(path.join(out, file)) };
  }

  step("4. Sign the image (index and every platform)");
  const tlog = options.tlog ? [] : ["--tlog-upload=false"];
  tool(TOOLS.cosign, ["sign", "--yes", "--recursive", "--key", KEY_IN_CONTAINER, ...tlog, ref], { keyFile });

  step("5. Attach the SBOMs as signed attestations");
  for (const [arch, platformDigest] of Object.entries(platforms)) {
    tool(TOOLS.cosign, ["attest", "--yes", "--key", KEY_IN_CONTAINER, "--type", "spdxjson", "--predicate", `/out/${sboms[arch].file}`, ...tlog, `${options.image}@${platformDigest}`], { out, keyFile });
  }

  step("6. release.json");
  const release = {
    schema: 1,
    releaseId,
    version: options.version,
    revision,
    image: options.image,
    digest,
    ref,
    tag: `${options.image}:${options.version}`,
    platforms,
    sboms,
    baseImages: baseImages(),
    tools: TOOLS,
    publicKeySha256: sha256File(pubFile),
    transparencyLog: options.tlog,
    buildSeconds,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(out, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  tool(TOOLS.cosign, ["sign-blob", "--yes", "--key", KEY_IN_CONTAINER, ...tlog, "--output-signature", "/out/release.json.sig", "/out/release.json"], { out, keyFile });
  writeFileSync(path.join(out, "cosign.pub"), readFileSync(pubFile));

  step("7. Verify with the public key only");
  verifyRelease({ out, image: options.image, digest, platforms, tlog: options.tlog });

  step("8. Tag the verified digest");
  // Only now does the version tag appear in the registry, pointing at exactly the signed digest.
  // --prefer-index=false copies the signed manifest as it is; by default a single source is wrapped
  // in a new index, whose digest would not be the signed one.
  run("docker", ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", release.tag, ref]);
  const tagged = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", release.tag, "--format", "{{json .Manifest}}"], { capture: true })).digest;
  if (tagged !== digest) throw new Error(`${release.tag} points at ${tagged}, not the signed ${digest}`);
  console.log(`tagged ${release.tag} -> ${digest}`);
  console.log(`\nRelease ${releaseId} signed, verified and tagged. Files: ${out}`);
  return release;
}

/** Verifies a release folder (release.json, its signature, cosign.pub) the way an installer would. */
export function verifyRelease({ out, image, digest, platforms, tlog = false }) {
  const offline = tlog ? [] : ["--insecure-ignore-tlog=true"];
  tool(TOOLS.cosign, ["verify", "--key", "/out/cosign.pub", ...offline, `${image}@${digest}`], { out, capture: true });
  for (const platformDigest of Object.values(platforms)) {
    tool(TOOLS.cosign, ["verify", "--key", "/out/cosign.pub", ...offline, `${image}@${platformDigest}`], { out, capture: true });
    tool(TOOLS.cosign, ["verify-attestation", "--key", "/out/cosign.pub", "--type", "spdxjson", ...offline, `${image}@${platformDigest}`], { out, capture: true });
  }
  tool(TOOLS.cosign, ["verify-blob", "--key", "/out/cosign.pub", ...offline, "--signature", "/out/release.json.sig", "/out/release.json"], { out, capture: true });
  console.log("verified: image signature (index and platforms), SBOM attestations, release.json signature");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nRelease stopped: ${error.message}`);
    process.exit(1);
  });
}
