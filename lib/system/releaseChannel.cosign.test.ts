import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadReleasePublicKey, verifyBlobSignature } from "./releaseChannel";

// The native verifier against a REAL `cosign sign-blob` signature. Skipped unless the upgrade E2E
// (scripts/release/test-upgrade.sh) points POLYNOVEA_COSIGN_FIXTURE at a release folder holding
// release.json, release.json.sig and cosign.pub made by the real cosign.
const fixture = process.env.POLYNOVEA_COSIGN_FIXTURE;

describe.skipIf(!fixture)("native verifier vs real cosign sign-blob output", () => {
  const read = (name: string) => readFileSync(path.join(fixture!, name));
  const key = () => loadReleasePublicKey({ POLYNOVEA_RELEASE_PUBKEY_FILE: path.join(fixture!, "cosign.pub") })!.key;

  it("accepts the real signature of the real release.json", () => {
    expect(verifyBlobSignature(read("release.json"), read("release.json.sig").toString("utf8"), key())).toBe(true);
  });

  it("refuses the same signature over release.json with one byte changed", () => {
    for (const offset of [0, Math.floor(read("release.json").length / 2), read("release.json").length - 2]) {
      const tampered = Buffer.from(read("release.json"));
      tampered[offset] ^= 0x01;
      expect(verifyBlobSignature(tampered, read("release.json.sig").toString("utf8"), key())).toBe(false);
    }
  });
});
