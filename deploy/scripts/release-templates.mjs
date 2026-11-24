#!/usr/bin/env node
// Bakes a release's images into the cloud templates, so a quick-create or "Deploy to Azure" link
// can't point a server at someone else's image. deploy/release-images.json is the single source:
//
//   {
//     "release": true,                                   // false = development build (see --release-check)
//     "cmsImage":   "ghcr.io/polynovea/cms@sha256:<64 hex>",
//     "caddyImage": "caddy@sha256:<64 hex>",            // Caddy's official image
//     "aws":   { "amis": { "eu-west-1": { "arm64": "ami-…", "amd64": "ami-…" } } },
//     "azure": { "galleryImages": { "x64": "/CommunityGalleries/<name>/Images/<def>/Versions/<v>", "arm64": "" } }
//   }
//
//   node deploy/scripts/release-templates.mjs                  # write the CloudFormation defaults and AMI map
//   node deploy/scripts/release-templates.mjs --check          # exit 1 if the template is out of step
//   node deploy/scripts/release-templates.mjs --release-check  # exit 1 unless this is a complete release
//       [--signed-release dist/release/<id>/release.json]      # and, given the signed manifest, its digests match
//   node deploy/scripts/release-templates.mjs --release-check --not-a-release
//                                                              # development: report what's missing, exit 0
//
// Bicep reads deploy/release-images.json itself (loadJsonContent); rebuild azuredeploy.json after a change.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_KEY } from "./sync-vm-bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const RELEASE_FILE = "deploy/release-images.json";
export const CFN = "deploy/aws/polynovea.yaml";
export const BOOTSTRAP = "deploy/scripts/vm-bootstrap.sh";

/** The only images a template accepts. */
export const CMS_IMAGE = /^ghcr\.io\/polynovea\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
export const CADDY_IMAGE = /^(?:docker\.io\/library\/)?caddy@sha256:[a-f0-9]{64}$/;
export const AMI = /^ami-[0-9a-f]{8,17}$/;
export const GALLERY_IMAGE = /^\/CommunityGalleries\/[A-Za-z0-9-]+\/Images\/[A-Za-z0-9._-]+\/Versions\/\d+\.\d+\.\d+$/;

/**
 * Every commercial AWS region. CloudFormation's FindInMap fails in a region missing from the map, so
 * the map lists them all ("none" = no Polynovea AMI there: Ubuntu 24.04 is used).
 */
export const AWS_REGIONS = [
  "af-south-1", "ap-east-1", "ap-east-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-south-1", "ap-south-2",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5", "ap-southeast-6", "ap-southeast-7",
  "ca-central-1", "ca-west-1", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2", "eu-west-1", "eu-west-2",
  "eu-west-3", "il-central-1", "me-central-1", "me-south-1", "mx-central-1", "sa-east-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
];

const BEGIN = "# BEGIN GENERATED release-amis";
const END = "# END GENERATED release-amis";

/** Reads and checks deploy/release-images.json. Throws on anything that isn't a Polynovea or Caddy image. */
export function loadRelease(text) {
  const r = JSON.parse(text);
  const fail = (m) => { throw new Error(`${RELEASE_FILE}: ${m}`); };
  if (typeof r.release !== "boolean") fail('"release" must be true or false');
  if (r.cmsImage !== "" && !CMS_IMAGE.test(r.cmsImage)) fail('"cmsImage" must be ghcr.io/polynovea/<name>@sha256:<64 hex>');
  if (r.caddyImage !== "" && !CADDY_IMAGE.test(r.caddyImage)) fail('"caddyImage" must be Caddy\'s official image, caddy@sha256:<64 hex>');
  for (const [region, byArch] of Object.entries(r.aws?.amis ?? {})) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) fail(`AWS region "${region}" isn't a region name`);
    for (const [arch, ami] of Object.entries(byArch)) {
      if (!["arm64", "amd64"].includes(arch)) fail(`AWS architecture "${arch}" must be arm64 or amd64`);
      if (ami !== "" && !AMI.test(ami)) fail(`"${ami}" (${region}, ${arch}) isn't an AMI ID`);
    }
  }
  for (const [arch, image] of Object.entries(r.azure?.galleryImages ?? {})) {
    if (!["x64", "arm64"].includes(arch)) fail(`Azure architecture "${arch}" must be x64 or arm64`);
    if (image !== "" && !GALLERY_IMAGE.test(image)) fail(`Azure gallery image "${image}" must be /CommunityGalleries/<name>/Images/<definition>/Versions/<x.y.z>`);
  }
  return r;
}

/** The CloudFormation template with the release's image defaults and AMI map. */
export function renderCfn(cfn, release) {
  const setDefault = (text, param, value) => {
    const re = new RegExp(`(\\n  ${param}:\\n    Type: String\\n    Default: )"[^"\\n]*"`);
    if (!re.test(text)) throw new Error(`${CFN}: parameter ${param} not found`);
    return text.replace(re, `$1"${value}"`);
  };
  let out = setDefault(cfn, "ContainerImage", release.cmsImage);
  out = setDefault(out, "CaddyImage", release.caddyImage);
  const amis = release.aws?.amis ?? {};
  const regions = [...new Set([...AWS_REGIONS, ...Object.keys(amis)])].sort();
  const lines = out.split("\n");
  const begin = lines.findIndex((l) => l.trim() === BEGIN);
  const end = lines.findIndex((l) => l.trim() === END);
  if (begin < 0 || end < begin) throw new Error(`${CFN} has no ${BEGIN} ... ${END} block`);
  const ami = (region, arch) => amis[region]?.[arch] || "none";
  const map = ["  ReleaseAmis:", ...regions.map((r) => `    ${r}: { arm64: ${ami(r, "arm64")}, amd64: ${ami(r, "amd64")} }`)];
  return [...lines.slice(0, begin + 1), ...map, ...lines.slice(end)].join("\n");
}

/** What a complete release still lacks (empty = ready to publish). */
export function releaseGaps(release, bootstrap, cfn, arm, signed = null) {
  const gaps = [];
  if (!release.release) gaps.push(`${RELEASE_FILE} says "release": false`);
  if (!release.cmsImage) gaps.push("no CMS image digest (cmsImage)");
  if (!release.caddyImage) gaps.push("no Caddy image digest (caddyImage)");
  if (!bootstrap.includes(`cat > "$FILES/${RELEASE_KEY}"`)) gaps.push(`the first-boot script has no ${RELEASE_KEY} (add release/packer/files/${RELEASE_KEY}, then run sync-vm-bootstrap.mjs)`);
  if (/\n  ContainerImage:\n    Type: String\n    Default: ""/.test(cfn)) gaps.push("CloudFormation ContainerImage default is blank");
  if (/\n  CaddyImage:\n    Type: String\n    Default: ""/.test(cfn)) gaps.push("CloudFormation CaddyImage default is blank");
  if (arm !== null) {
    const json = JSON.stringify(arm);
    if (release.cmsImage && !json.includes(release.cmsImage)) gaps.push("azuredeploy.json doesn't carry the CMS image: run deploy/scripts/build-azure.sh");
    if (release.caddyImage && !json.includes(release.caddyImage)) gaps.push("azuredeploy.json doesn't carry the Caddy image: run deploy/scripts/build-azure.sh");
  }
  if (signed) gaps.push(...signedReleaseGaps(release, bootstrap, signed));
  return gaps;
}

/**
 * Checks against the signed release manifest (release.json from scripts/release/build-and-sign.mjs,
 * schema 1): the CMS image must be its `ref` (or `image@digest`), and the key the first-boot script
 * carries must hash to its `publicKeySha256`. Caddy isn't in the manifest (it isn't our image).
 */
export function signedReleaseGaps(release, bootstrap, signed) {
  const gaps = [];
  if (signed.schema !== 1) return [`the signed release manifest has schema ${signed.schema}; this check knows schema 1`];
  const signedRef = typeof signed.ref === "string" && signed.ref.includes("@sha256:") ? signed.ref : `${signed.image}@${signed.digest}`;
  if (release.cmsImage !== signedRef) gaps.push(`cmsImage (${release.cmsImage || "blank"}) isn't the signed release's image (${signedRef})`);
  const key = new RegExp(`cat > "\\$FILES/${RELEASE_KEY.replace(".", "\\.")}" <<'POLYNOVEA_FILE_END'\\n([\\s\\S]*?)POLYNOVEA_FILE_END`).exec(bootstrap)?.[1];
  if (!key) gaps.push(`the first-boot script has no ${RELEASE_KEY} to compare with the signed release's key`);
  else if (createHash("sha256").update(key).digest("hex") !== signed.publicKeySha256) gaps.push(`the first-boot script's ${RELEASE_KEY} isn't the key the release was signed with (publicKeySha256 differs)`);
  return gaps;
}

function main(argv) {
  const release = loadRelease(readFileSync(path.join(ROOT, RELEASE_FILE), "utf8"));
  const cfnPath = path.join(ROOT, CFN);
  const cfn = readFileSync(cfnPath, "utf8");
  const expected = renderCfn(cfn, release);
  if (argv.includes("--release-check")) {
    const armPath = path.join(ROOT, "deploy/azure/azuredeploy.json");
    const arm = existsSync(armPath) ? JSON.parse(readFileSync(armPath, "utf8")) : null;
    // The signed release manifest, when there is one: --signed-release <file> or POLYNOVEA_SIGNED_RELEASE.
    const signedPath = argv.includes("--signed-release") ? argv[argv.indexOf("--signed-release") + 1] : process.env.POLYNOVEA_SIGNED_RELEASE;
    const signed = signedPath ? JSON.parse(readFileSync(path.resolve(signedPath), "utf8")) : null;
    const gaps = releaseGaps(release, readFileSync(path.join(ROOT, BOOTSTRAP), "utf8"), cfn, arm, signed);
    if (!signed) console.log("release check: no signed release manifest given (--signed-release <file> or POLYNOVEA_SIGNED_RELEASE); digests not compared with it");
    if (expected !== cfn) gaps.push(`${CFN} is out of step with ${RELEASE_FILE}: run node deploy/scripts/release-templates.mjs`);
    if (gaps.length === 0) { console.log("release check: ready"); return; }
    const notRelease = argv.includes("--not-a-release");
    console[notRelease ? "log" : "error"](`release check: ${notRelease ? "not a release (development build); missing" : "NOT READY"}:\n- ${gaps.join("\n- ")}`);
    process.exit(notRelease ? 0 : 1);
  }
  if (expected === cfn) { console.log("up to date"); return; }
  if (argv.includes("--check")) {
    console.error(`${CFN} is out of step with ${RELEASE_FILE}. Run: node deploy/scripts/release-templates.mjs`);
    process.exit(1);
  }
  writeFileSync(cfnPath, expected);
  console.log(`wrote ${CFN}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
