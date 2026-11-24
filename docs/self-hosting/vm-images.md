# VM images for AWS and Azure

The VM images are Ubuntu 24.04 LTS with Docker and one signed Polynovea CMS release already on board. The cloud templates (`deploy/aws`, `deploy/azure`) launch them; you can also launch one by hand. Definitions: [`release/packer/`](../../release/packer/).

| | AWS (AMI) | Azure (managed image) |
| --- | --- | --- |
| Base | Canonical Ubuntu 24.04 LTS (`ubuntu-noble-24.04-<arch>-server`, owner 099720108477) | `Canonical:ubuntu-24_04-lts:server` (or `server-arm64`) |
| Architectures | `amd64`, `arm64` (Graviton, such as t4g) | `amd64`, `arm64` |
| Instance metadata | **IMDSv2 required** (`imds_support = "v2.0"`, so every instance launched from the AMI requires tokens), hop limit 2 | Azure IMDS already needs a `Metadata: true` header and refuses forwarded requests; there is no switch to turn on |
| Root disk | 16 GB gp3; encrypted with the account's default key, or unencrypted when built for publishing (`aws_publishable`), then encrypted at launch | Platform default |

## What is on the image

- **Automatic security updates** (`unattended-upgrades`): security updates every day, a reboot at 04:00 server time when one needs it (kernel, libc). Docker comes from Ubuntu's own archive, so it is updated the same way. The CMS and its database come back with the VM.
  - These cover the VM itself: Ubuntu, its kernel and Docker. **They do not reach inside the CMS container.** Node.js, PostgreSQL 16 and pgBackRest in the container are fixed only by a new Polynovea release image (rebuilt on the patched, digest-pinned base, signed, and installed with an upgrade). Keep releases current; the System page shows when one is available.
- **Docker**, logging to the system journal, kept for 14 days.
- **The CMS image**, pulled by digest when the VM image was built (`/etc/polynovea/image.env` records which one), and the Caddy image, also by digest.
- Systemd units:
  - `polynovea-data-disk.service` + `var-lib-polynovea.mount`: find the data disk and mount it at `/var/lib/polynovea` (below);
  - `polynovea.service`: runs the CMS (`/opt/polynovea/run-cms.sh`) with host networking, on `127.0.0.1:3000`;
  - `polynovea-caddy.service`: runs Caddy for HTTPS, only when a domain is set;
  - `polynovea-console-code.service`: copies the one-time setup code (that line only) to the serial console while the CMS is in setup mode, so the owner can read it from the cloud console without SSH. It writes nothing once setup is finished, or when the CMS does not answer. Until setup is finished, anyone in the cloud account who can read console output can see the code.

## Instance metadata and credentials (AWS)

IMDSv2 is required, so a request needs a session token first. That blocks the classic attack where a server-side request forgery (SSRF) bug reads credentials with a single GET. The hop limit is **2**, not the tightest setting of 1. A hop limit of 1 would stop any container on a Docker bridge network from reaching the metadata service. With 2, **every container on the VM, including ones on a bridge network, can obtain the instance role's credentials.** We accept this because:

- the CMS container needs those credentials for pgBackRest's S3 backups;
- the image runs only our signed containers (the CMS and Caddy), and verify-images.sh refuses anything else;
- the instance role allows only reading one secret and writing to one bucket (the templates).

Don't run other people's containers on this VM. If you do, give them a separate VM or a hop limit of 1 and your own credentials.

## Every start checks the images first

`polynovea.service` and `polynovea-caddy.service` run `/opt/polynovea/verify-images.sh` before every start (`ExecStartPre`), on a VM made from our image and on the plain-Ubuntu path alike. If a check fails, systemd does not start the service:

- the CMS image must be pinned by digest **and** its signature must verify with the Polynovea release public key in `/etc/polynovea/release.pub` (installed by `provision.sh` from `release/packer/files/polynovea-release.pub`), using cosign from its own image, pinned by digest. The signature is read from the image's own registry; no other trust material is fetched;
- the Caddy image must be pinned by digest (it is Caddy's own image, which we do not sign);
- a digest that verified once with this exact key is remembered in `/var/lib/polynovea-verified`, so a restart while the registry is unreachable still starts the image it already checked, and never a different one.

`provision.sh` runs the same check right after pulling, so a VM image build or a plain-Ubuntu bootstrap with a bad image stops before anything starts. It refuses to run at all without the release public key.

## The data disk at `/var/lib/polynovea`

Everything the CMS keeps is on a **separate data disk**, never on the root disk: the master key, `config.enc`, the bundled database for **On this server**, and its local backups. Attach one when you launch the VM (on AWS, in the instance's block device mappings; on Azure, as data disk LUN 0). 8–16 GB is plenty for a trial; size it for your content and local backups.

At every boot, `polynovea-data-disk.service`:

1. does nothing if a disk labelled `POLYNOVEA_DATA` exists;
2. otherwise picks the data disk: `POLYNOVEA_DATA_DEVICE` from `/etc/polynovea/polynovea.env` if set, else Azure's LUN 0, else the AWS EBS volume that is not the root disk (instance-store disks are never used);
3. formats it (ext4, label `POLYNOVEA_DATA`) **only if** it is a whole disk with no partitions, no filesystem or other signature, and not mounted, and it is the only such disk. A disk that already holds anything is never touched.

It waits up to 5 minutes for the disk to appear. Without one, the CMS does not start, and the journal says why (`journalctl -u polynovea-data-disk`). The CMS will not run with its data on the root disk.

## Settings: `/etc/polynovea/polynovea.env`

The templates' user data writes this file. **Non-secret values only**: the CMS keeps its secrets in `config.enc` on the data disk.

| Key | Meaning |
| --- | --- |
| `POLYNOVEA_DB_SECRET_REF` | The "Created for you" database's secret (ARN or Key Vault URI) |
| `AWS_REGION` | AWS region (for the AWS SDK and pgBackRest's S3 backups) |
| `POLYNOVEA_DOMAIN` | Optional. Turns on HTTPS with Caddy and sets `POLYNOVEA_PUBLIC_URL=https://<domain>` |
| `POLYNOVEA_PUBLIC_URL` | Optional, without a domain only. The address you open through the SSH tunnel (default `http://localhost:3000`); passkeys and sign-in belong to it |
| `POLYNOVEA_ACME_EMAIL` | Optional. Where Let's Encrypt sends certificate-expiry warnings. Without it, certificates are still issued |
| `POLYNOVEA_BACKUP_BUCKET`, `POLYNOVEA_BACKUP_ACCOUNT`, `POLYNOVEA_BACKUP_CONTAINER` | The backup location the template created (for **On this server**) |
| `POLYNOVEA_IMAGE_REF` | Optional. A different CMS release, pinned by digest (the upgrade flow sets this) |
| `POLYNOVEA_DATA_DEVICE` | Optional. The data disk's device, when automatic detection is not enough |

`HOSTNAME`, `PORT`, `POLYNOVEA_CONFIG_DIR` and the trusted proxy are set by `run-cms.sh` and win over the file. The CMS must listen on loopback only.

## Plain Ubuntu instead of our image

The templates can also start from Canonical's plain Ubuntu 24.04 image (AMIs are per region and Azure images per subscription, so a one-click link works before ours are published). Their bootstrap copies `release/packer/files/*` and `docker/Caddyfile` to the VM and runs the same `release/packer/provision.sh` with `POLYNOVEA_START_NOW=1`, through `systemd-run` (not inline in user data: the script first waits for cloud-init to finish). The result is the same files and services as a VM made from our image, and the services start at once. `scripts/image/test-vm-files.sh` checks that both paths end in the same state, and that running the script twice changes nothing.

## Reaching the setup wizard

- **Without a domain:** ports 80 and 443 answer nothing. Set up through an SSH tunnel: `ssh -L 3000:127.0.0.1:3000 ubuntu@<server>` (AWS) or `ssh -L 3000:127.0.0.1:3000 azureuser@<server>` (Azure), then open `http://localhost:3000/setup`: exactly that address, which the server sets as `POLYNOVEA_PUBLIC_URL` when there is no domain. The setup wizard's passkey and every sign-in belong to it, and `http://127.0.0.1:3000` is a different address to your browser. To use another address, set `POLYNOVEA_PUBLIC_URL` in `/etc/polynovea/polynovea.env`. The setup code is in `journalctl -t polynovea` (or `sudo docker logs polynovea`), and on the serial console.
- **With `POLYNOVEA_DOMAIN`:** point the domain at the server, open 80 and 443, and use `https://<domain>/setup`. Caddy gets a Let's Encrypt certificate (it answers the HTTP-01 challenge on port 80). Setup through the tunnel is then refused, because the wizard only accepts its public address.

Why the CMS is never published straight on a port: see [container.md](container.md#why-not-just-publish-port-3000).

## Building the images (release machine only)

Build only on a release machine with your own cloud credentials, after the release is signed (`scripts/release/build-and-sign.mjs` verifies the signature). The VM image then pulls exactly that digest, so what it carries is what was signed. **Never from GitHub Actions.**

```
cat > release.pkrvars.hcl <<'EOF'
image_ref  = "ghcr.io/polynovea/cms@sha256:<digest from release.json>"
release_id = "0.4.0+abc1234"
arch       = "arm64"            # or amd64
aws_region = "eu-west-1"
azure_location       = "westeurope"
azure_resource_group = "polynovea-images"
EOF
packer init release/packer
packer build -only='polynovea-aws.*'   -var-file=release.pkrvars.hcl release/packer
packer build -only='polynovea-azure.*' -var-file=release.pkrvars.hcl release/packer   # after az login
```

A build launches one small temporary VM in your account for about 10 minutes and stores one image (a few GB of snapshot storage). Packer removes the temporary VM; delete old images yourself.

## Publishing (when the owner decides; not done yet)

The default build is for the building account only. To offer the images to other people's accounts:

**AWS: a public AMI, encrypted at launch.**

- An AMI whose root snapshot is encrypted with the AWS-managed EBS key (`aws/ebs`, the default) can't be shared or made public. Build with `aws_publishable = true`: the snapshot is then unencrypted. It holds no secrets: the CMS keeps everything on the separate data disk, created at launch.
- Every launch encrypts its volumes: the CloudFormation template sets `Encrypted: true` on the root and data volumes (with the customer's own key if they choose one). Customers can also turn on their account's EBS encryption by default.
- After the build, in each region:
  - make the AMI public: `aws ec2 modify-image-attribute --image-id <ami> --launch-permission "Add=[{Group=all}]"`;
  - remove the account's "block public access for AMIs" setting first, if it is on.
- Record the AMI IDs per region in the release notes and in the template's region map.

**Azure: an Azure Compute Gallery shared with the community.**

- A managed image (`/subscriptions/…/providers/Microsoft.Compute/images/…`, what a plain build makes) is **for testing in your own subscription only**: it cannot leave that subscription, and VMs made from it cannot use Trusted Launch, so the templates switch Trusted Launch off for it. For anything real, use a gallery image (the community gallery below, or a gallery in your own subscription). Publish through an Azure Compute Gallery instead. Create it once, with community sharing and the publisher details the portal shows to users:
  - `az sig create --gallery-name <gallery> --resource-group <rg> --permissions community --publisher-uri <url> --publisher-email <email> --eula <url> --public-name-prefix polynovea`
  - then `az sig share enable-community --gallery-name <gallery> --resource-group <rg>`.
- Create one image definition per architecture, marked Trusted Launch-capable (without `--features SecurityType=TrustedLaunchSupported`, VMs from the gallery image cannot use Trusted Launch, so the template would have to turn it off):
  `az sig image-definition create --gallery-name <gallery> --resource-group <rg> --gallery-image-definition polynovea-cms[-arm64] --publisher Polynovea --offer polynovea-cms --sku <x64|arm64> --os-type Linux --os-state Generalized --hyper-v-generation V2 --architecture x64|Arm64 --features SecurityType=TrustedLaunchSupported`.
  Packer does not create the definition; it only adds image versions to it (Ubuntu 24.04's Gen2 image is Trusted Launch-capable).
- Build with:
  - `azure_gallery_name`, `azure_gallery_resource_group`, `azure_gallery_image_name` and `azure_gallery_image_version` (major.minor.patch, e.g. `0.4.0`);
  - `azure_gallery_regions` for replication.
  Packer then publishes the image version to the gallery (and still makes the managed image).
- The template refers to the community gallery image by its public name: `/CommunityGalleries/<public name>/Images/<definition>/Versions/<version>`.

Making either public is a publishing decision for the project lead (Subrojit). Until then, builds stay private to the building account or subscription.

## What is tested where

These are **not run on a developer machine, by design**: they need real cloud accounts, a public domain or a real VM. Subrojit's first Azure deployment covers them:

- building the AMI and the Azure image in the cloud, and publishing them (public AMI, community gallery);
- pgBackRest backups to a real S3 bucket or Azure Blob container, using the instance role or managed identity;
- Caddy getting a real Let's Encrypt certificate for a public domain;
- the systemd units, the data-disk detection and the serial-console code under a real systemd on a real VM.

Everything else is checked locally: the image end to end (`scripts/image/run-smoke.sh`), these VM files with stand-ins for systemd, Docker and cosign (`scripts/image/test-vm-files.sh`), release signing against a throwaway local registry (`scripts/release/test-release.sh`), and the Packer definitions (below).

## Checking the definitions without a cloud account

```
docker run --rm -v "$PWD:/w" -w /w hashicorp/packer:1.14.2@sha256:250bf3081634255dcabb112ceefd8c77f0b9093e16b21a15516d03a7e996d239 init release/packer
docker run --rm -v "$PWD:/w" -w /w hashicorp/packer:1.14.2@sha256:250bf3081634255dcabb112ceefd8c77f0b9093e16b21a15516d03a7e996d239 validate -syntax-only release/packer
```

plus `shellcheck` on `release/packer/provision.sh` and `release/packer/files/*.sh`, and `scripts/image/test-vm-files.sh` (provision in an Ubuntu container, the console line, the Caddyfile). These need no credentials and create nothing.
