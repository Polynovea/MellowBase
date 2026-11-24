# Installing Polynovea CMS in your own cloud

These templates create everything a Polynovea CMS install needs in **your own** AWS or Azure account: a server, a PostgreSQL database, a bucket or container for backups and files, the one secret the server may read, and a budget alert. Polynovea never gets access to your account. You see the whole template and its permissions before anything is created.

| Path | For | Start here |
| --- | --- | --- |
| AWS CloudFormation, quick-create link | Anyone with an AWS account | [aws/README.md](aws/README.md) |
| Azure Bicep, "Deploy to Azure" button | Anyone with an Azure subscription | [azure/README.md](azure/README.md) |
| OpenTofu modules | Technical teams who manage infrastructure as code | [opentofu/README.md](opentofu/README.md) |

## Choosing where the database runs

Every path has the same two options:

| `DatabaseMode` / `databaseMode` | What you get | Setup wizard step | Approx. US$/month |
| --- | --- | --- | --- |
| `managed` (default) | The cloud's PostgreSQL 16 service (RDS or Flexible Server): automatic backups, patching and point-in-time restore | **Created for you**: nothing to type | AWS about 34, Azure about 56 |
| `on-this-server` | PostgreSQL on the server's data disk, backed up by pgBackRest to the bucket or container the template made | **On this server**: choose the bucket or container from the template's outputs | AWS about 20, Azure about 39 |

These are estimates from on-demand list prices (AWS us-east-1, Azure East US, November 2026), before tax, with light traffic. Your cloud bill is what counts, and the budget alert tells you early if it runs high. Some costs outlive the server, so they're not in the monthly figures: the database's and data disk's **final snapshots** when you delete the install, the **retained bucket or storage account** and its backups, and the **database secret** (US$0.40 a month on AWS) until you delete them. Database storage also **grows automatically** (AWS up to 200 GB, Azure in steps), and each step costs more.

## Reaching the setup wizard

The CMS listens on the server itself only (127.0.0.1:3000). There are two ways in, and every template asks you to pick at least one:

| You set | Ports open to the internet | Setup wizard | Setup code |
| --- | --- | --- | --- |
| A domain (`Domain` / `domain`) | 80 and 443, answered by Caddy, which gets a free Let's Encrypt certificate once the domain's A record points at the server's `PublicIp` | `https://<domain>/setup` | In the cloud console (the `SetupCode` output has the exact clicks), or over SSH |
| No domain, your IP address (`AdminCidr` / `adminCidr`) and an SSH key | Only SSH, from your address | `http://localhost:3000/setup` through the SSH tunnel from the `SshTunnel` output | The same, or in the SSH session |

With a domain set, the wizard refuses the SSH tunnel: once the site has a public address, setup must happen on that address.

## How the template hands over to the release package

The template writes non-secret settings to `/etc/polynovea/polynovea.env`, using the keys the release package reads:

| Setting | Value |
| --- | --- |
| `POLYNOVEA_DB_SECRET_REF` | *Managed only.* The address of the secret holding the database's admin login: a Secrets Manager ARN on AWS, a Key Vault secret URI on Azure. The wizard's "Created for you" step reads it once through the server's own identity. It's an address, not the secret. |
| `AWS_REGION` | *AWS only.* For the AWS SDK and pgBackRest |
| `POLYNOVEA_BACKUP_BUCKET` (AWS), `POLYNOVEA_BACKUP_ACCOUNT` + `POLYNOVEA_BACKUP_CONTAINER` (Azure) | The bucket or container this install may use. The wizard suggests them for "On this server" backups. |
| `POLYNOVEA_DOMAIN`, `POLYNOVEA_ACME_EMAIL` | When a domain is given: turns on HTTPS through Caddy |
| `POLYNOVEA_IMAGE_REF`, `POLYNOVEA_CADDY_IMAGE_REF` | The CMS and Caddy images, pinned by digest, when given. A Polynovea server image already carries both. |

The release package sets `HOSTNAME`, `PORT` and `POLYNOVEA_CONFIG_DIR` itself, and `POLYNOVEA_TRUSTED_PROXIES` (to 127.0.0.1) only when a domain is set. The templates never set any of them.

The secret holds JSON with `host`, `port`, `username`, `password` and `dbname`, the shape `lib/setup/database/createdForYou.ts` reads. `deploy/templates.test.ts` checks that every template produces a reference and a secret that parser accepts.

**First boot.** The server runs [scripts/vm-bootstrap.sh](scripts/vm-bootstrap.sh) as its own systemd unit (`journalctl -u polynovea-bootstrap`). On a Polynovea server image it just restarts the CMS, so it picks up the new settings. On plain Ubuntu 24.04 it installs exactly what the server image has, using the release package's own files: Docker, automatic security updates, the data-disk and CMS units, and Caddy. The script is **generated** from those files by `node deploy/scripts/sync-vm-bootstrap.mjs`, which also refreshes the copies in the CloudFormation template (gzipped, to fit EC2's 16 KB user-data limit) and the OpenTofu modules. Never edit it by hand. The unit test fails if it falls out of step with the release package's files.

First boot **fails closed**. Images are pulled only by digest (`name@sha256:...`). When the release package ships a signature check at `/opt/polynovea/verify-images.sh`, it runs before anything starts. If any step fails, the CMS and Caddy are stopped and disabled, so nothing unverified runs, even after a reboot.

Plain Ubuntu plus a pinned container image is the default, because it works from a one-click link in every region. A Polynovea server image can be used only once it's published (see "Publishing" in `docs/self-hosting/vm-images.md`; a decision for the project lead):

- **AWS:** a public AMI in each region, built with `aws_publishable = true` (an unencrypted root snapshot with no secrets on it). The template still encrypts every volume at launch. The release script writes each region's AMI ID into the template's `ReleaseAmis` map (from `deploy/release-images.json`); no link or parameter can name another AMI.
- **Azure:** an image version in an Azure Compute Gallery shared with the community. Pass `/CommunityGalleries/<public name>/Images/<definition>/Versions/<version>` as `customImageId`. A managed image only works inside its own subscription. The VM uses Trusted Launch (secure boot and a virtual TPM) on x64 with the Ubuntu image or a gallery image, so **the gallery image definition must be created with `--features SecurityType=TrustedLaunchSupported`** (as in `vm-images.md`). Otherwise the deployment fails. A managed image can't use Trusted Launch, so it runs without it.

## Paid hardening upgrades

The templates are built for one small server at the lowest sensible cost, with security that costs nothing extra on by default: metadata tokens required, a private database, encryption at rest everywhere, deletion protection, and a server identity that can read one secret and use one bucket. Larger or regulated sites can add these paid upgrades. None is switched on by default, and each one raises the monthly bill:

| Upgrade | What it adds | Roughly, per month |
| --- | --- | --- |
| Customer-managed encryption keys (AWS KMS, Azure Key Vault keys) | You control and can revoke the keys for the database, disks, bucket and secret | about US$1 per key, plus requests |
| Multi-AZ database (AWS) / zone-redundant high availability (Azure) | A standby database in a second zone that takes over automatically | roughly doubles the database cost |
| Geo-redundant backups (Azure) / cross-region bucket replication (AWS) | Backups survive the loss of a whole region | extra storage and transfer |
| Private endpoints for Key Vault and storage (Azure) | Traffic to them never uses a public address | about US$7 each |
| VPC flow logs, database query and audit logs, bucket access logs | A record of network and data access for investigations | log storage, priced per GB |
| Enhanced and detailed monitoring | Per-minute server and database metrics | a few US$ |

`deploy/scripts/checkov.yaml` lists each policy check these would satisfy, labelled "paid extra", next to the ones skipped "by design".

## Publishing a release

The templates in the repository are a **development build**: they carry no image digests and no release key, so a server made from them stops before starting the CMS (fail closed). To publish:

1. Put the release's public key at `release/packer/files/polynovea-release.pub`, then run `node deploy/scripts/sync-vm-bootstrap.mjs`.
2. Fill in `deploy/release-images.json` from the signed release manifest (`dist/release/<id>/release.json`; don't hand-edit it during development): `"release": true`, the CMS and Caddy image digests, and any published AMIs and Azure gallery images. Then run `node deploy/scripts/release-templates.mjs` and `bash deploy/scripts/build-azure.sh`.
3. Run `POLYNOVEA_RELEASE=1 POLYNOVEA_SIGNED_RELEASE=dist/release/<id>/release.json bash deploy/scripts/validate.sh`. With the signed manifest given, the gate also checks that the CMS image is the signed release's and that the embedded key is the one the release was signed with (`publicKeySha256`). Its **release gate** fails until the first-boot script embeds the key and every template defaults to the release's images. Without `POLYNOVEA_RELEASE=1` the gate runs with `--not-a-release`: it lists what's missing and passes, so development and tests keep working.
4. Upload the release's `aws/polynovea.yaml` and `azure/azuredeploy.json` to public, versioned addresses for the quick-create link and the "Deploy to Azure" button.

## What isn't tested on this laptop, by design

No cloud account is used during development: nothing is deployed and nothing costs money. So these are **not run locally**, on purpose:
- cloud builds of the server images, and publishing them (public AMIs, the Azure community gallery);
- real backups to S3 or Azure Blob;
- real Let's Encrypt certificates;
- the real systemd first boot on a cloud VM.

The templates are checked offline instead (below), and the release package tests its first-boot files in containers. Subrojit's end-to-end Azure deployment covers the real thing later, following the checklist in [azure/README.md](azure/README.md#checklist-for-the-first-end-to-end-test).

## Validating the templates (no cloud account)

```bash
npx vitest run deploy/templates.test.ts   # secret reference + policy checks, no Docker
bash deploy/scripts/validate.sh           # release gate, cfn-lint, bicep build + lint, tofu fmt/validate, shellcheck, checkov
bash deploy/scripts/build-azure.sh        # recompile azure/azuredeploy.json after editing main.bicep
node deploy/scripts/sync-vm-bootstrap.mjs # regenerate the first-boot script after the release package's VM files change
```

`validate.sh` runs every tool in a throwaway container with no credentials, and creates nothing in any cloud. It waits for the laptop's shared heavy-job lock first. Checkov findings that are deliberate trade-offs (mostly paid extras such as customer-managed keys, flow logs and multi-zone databases) are skipped in [scripts/checkov.yaml](scripts/checkov.yaml), each with its reason.

Testing a real install needs a real account and costs money. The [Azure README](azure/README.md#checklist-for-the-first-end-to-end-test) has the end-to-end checklist.
