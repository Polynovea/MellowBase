# Signing releases

Every Polynovea CMS release image is signed with **cosign**, and published with an **SBOM** (a list of every package inside, in SPDX format). Installers and upgrades check the signature with our public key before they run an image.

We sign with a **key pair kept on a local release machine**, not with GitHub Actions. That is the owner's rule (no organisation Actions minutes). "Keyless" Sigstore signing would need Actions' identity, so it is not used.

## The release script

```
COSIGN_PASSWORD='<from the password manager>' node scripts/release/build-and-sign.mjs \
  --image ghcr.io/polynovea/cms --version 0.4.0 --key /secure/polynovea-release.key \
  --docker-config /secure/registry-login
```

It stops at the first failure, and in order:

1. checks the working tree is committed and the key pair exists (it never prints or copies the private key);
2. builds `linux/amd64` and `linux/arm64` and pushes once, recording the image digest;
3. makes an SPDX SBOM for each platform with **syft**;
4. signs the image index and every platform image with cosign;
5. attaches each SBOM to its platform image as a **signed attestation**;
6. writes `release.json` (release ID, digests, SBOM hashes, base image and tool digests, the public key's hash) and signs it;
7. verifies all of it again with the public key alone, as an installer would.

Output folder (`dist/release/<release ID>/`): `release.json`, `release.json.sig`, `sbom-amd64.spdx.json`, `sbom-arm64.spdx.json`, `cosign.pub`, `build-metadata.json`. Publish them with the release.

syft (`anchore/syft:v1.33.0`) and cosign (`ghcr.io/sigstore/cosign/cosign:v2.6.1`) run from their images, pinned by digest, so the release machine only needs Docker, Node.js 24 and git. `--tlog` also records the signatures in Sigstore's public transparency log (Rekor). It is off by default.

## Key handling

The private key is the one thing that makes a release ours. If it leaks, anyone can sign an image our installers would trust.

- **Create it once**, on the release machine: `cosign generate-key-pair` (in the cosign image, as `scripts/release/test-release.sh` shows), with a long random password. That writes `cosign.key` (encrypted with the password) and `cosign.pub`. Rename them `polynovea-release.key` and `.pub`.
- **Where it lives:** the release machine's encrypted disk, readable only by the release user. Keep one offline, encrypted backup (for example an encrypted USB key in a safe). Keep the password in the company password manager, never in a file next to the key.
- **Never** commit it, paste it into a chat or ticket, copy it to a server, put it in CI, or bake it into an image. `.dockerignore` excludes `*.key` and `cosign.*`, and the test checks that no private key reaches the release output.
- **Using it:** give the password to the script only through `COSIGN_PASSWORD` in that one command's environment. The script passes it, by name and never on a command line, only to the three cosign steps that sign (sign, attest, sign-blob), and mounts only the key file itself, read-only. syft and the verify steps see neither.
- **Publishing the public key:** `cosign.pub` goes in each release's output, on the website and in the README. Installers pin its hash (`publicKeySha256` in `release.json`). Before the first VM image or template release, commit it as `release/packer/files/polynovea-release.pub`: every VM checks each CMS image against that key before starting it, and `provision.sh` refuses to run without it.
- **Rotation or loss:** make a new pair, and publish the new public key in a release signed with the old key (if you still have it). If the old key leaked, announce it, mark the releases signed after the leak as untrusted, and re-sign the current release with the new key.

## Checking a release by hand

```
cosign verify --key cosign.pub --insecure-ignore-tlog=true ghcr.io/polynovea/cms@sha256:<digest>
cosign verify-attestation --key cosign.pub --type spdxjson --insecure-ignore-tlog=true ghcr.io/polynovea/cms@sha256:<platform digest>
cosign verify-blob --key cosign.pub --insecure-ignore-tlog=true --signature release.json.sig release.json
```

(`--insecure-ignore-tlog=true` only says "this signature is not in the public transparency log", which is our default; the key check is fully enforced.)

## Testing the whole flow on one machine

`scripts/release/test-release.sh` runs the real script against a throwaway registry bound to `127.0.0.1` and a throwaway key pair with a random password. Nothing leaves the machine. It then checks that another key, an unsigned image and an edited `release.json` all fail verification, and removes the registry, its volume, the keys and its images.
