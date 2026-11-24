# Polynovea CMS on Azure (Bicep)

`main.bicep` creates a complete Polynovea CMS install in **your own** Azure subscription. Polynovea gets no access to it. `azuredeploy.json` is the same template compiled to ARM JSON, which the **Deploy to Azure** button opens. Never edit it by hand: run `bash deploy/scripts/build-azure.sh` after changing `main.bicep`.

## What it creates

| Resource | Setting | Approx. US$/month (East US, Nov 2026) |
| --- | --- | --- |
| Virtual machine | `Standard_B2s` (2 vCPU, 4 GB), Ubuntu 24.04 LTS, Trusted Launch (secure boot and vTPM) on x64, SSH keys only, system-assigned managed identity; the CMS and Caddy as pinned containers | 30.37 |
| OS disk | 30 GB Standard SSD | 2.40 |
| Data disk | 32 GB Standard SSD at `/var/lib/polynovea`, kept if the VM is deleted | 2.40 |
| Public IP | Standard, static, with a DNS name | 3.65 |
| PostgreSQL *(managed only)* | Flexible Server 16, Burstable `Standard_B1ms`, 32 GB (grows automatically), single zone, no public access, TLS required, 7-day backups, delete lock | 16.09 |
| Private DNS zone *(managed only)* | For the database's private address | 0.50 |
| Key Vault *(managed only)* | RBAC, purge protection, firewall admits only the VM's subnet; one secret | under 0.10 |
| Storage account + one container | Locally redundant, Entra ID only (no shared keys), no public access, TLS 1.2, 14-day soft delete, delete lock | under 0.50 for a few GB |
| Budget alert | Emails you at 80% of the monthly budget, and when spending is forecast to pass 100% | free |
| **Total** | | **about 56 managed, about 39 on-this-server** |

Prices are estimates from Azure's pay-as-you-go list prices, before tax, with light traffic. Other regions and heavy traffic cost more; your Azure bill is what counts. They are printed in the template's description too.

### Security

- **One identity, two permissions.** The VM's managed identity gets **Key Vault Secrets User** on the one database secret (not the vault) and **Storage Blob Data Contributor** on the one container (not the account). Nothing else.
- **The database is reachable from the VM only.** It has no public address, sits in its own delegated subnet, and that subnet's network security group admits port 5432 from the VM's subnet and nothing else. The VM's own group opens 80 and 443 only when a domain is set (Caddy answers them), SSH only from `adminCidr`, and inside the virtual network the VM can reach only the database.
- **No secret in custom data.** The VM's settings file (`/etc/polynovea/polynovea.env`) holds only the secret's *address* (`POLYNOVEA_DB_SECRET_REF`), the storage names, the domain and the image digests. Custom data is readable on the VM and cloud-init keeps a copy, so it must never hold a password.
- **The database password** is generated during deployment by Azure Resource Manager (`newGuid()` in a `@secure()` parameter, about 122 random bits, never shown in the portal or kept in the deployment history) and written straight into Key Vault. Key Vault can't generate passwords itself. Each redeployment generates a new one and updates both the database and the secret together. After setup the CMS no longer uses the admin login: it signs in with its own `polynovea_owner` and `polynovea_app` roles.
- **Deletion protection.** Flexible Server has no deletion-protection switch, so the template puts a `CanNotDelete` lock on the database and on the storage account. Key Vault has purge protection.

## Before you start

1. **An Azure subscription where you are Owner** of the resource group, or Contributor plus User Access Administrator. The template creates role assignments and locks, which plain Contributor can't do.
2. **The resource providers registered** (once per subscription): `Microsoft.Compute`, `Microsoft.Network`, `Microsoft.Storage`, `Microsoft.KeyVault`, `Microsoft.DBforPostgreSQL` and `Microsoft.Consumption`. In the portal: **Subscriptions → your subscription → Resource providers**, select each one, **Register**. Deployment usually registers them itself if you are a subscription Owner.
3. **An SSH public key.** Azure needs one for a Linux VM. To make one in the portal: search **SSH keys → Create → Generate new key pair → Review + create → Download private key and create resource**. Keep the downloaded `.pem` file safe, and paste the **public** key (it starts with `ssh-rsa` or `ssh-ed25519`) into the template.
4. **Your public IP address**, for SSH. Search "what is my IP" and add `/32`, for example `203.0.113.7/32`. Without a domain, SSH is the only route into the setup wizard. With a domain it is optional: the setup code is also shown in the portal.
5. **Optionally, a domain** (for example `cms.example.com`) whose DNS you can change. With one, the site gets HTTPS and setup is at `https://<domain>/setup`. Without one, ports 80 and 443 stay closed and setup goes through an SSH tunnel.
6. **A region with Flexible Server Burstable capacity.** Some subscription offers (free trials, some sponsorships) restrict PostgreSQL Flexible Server or budgets in some regions. If deployment fails with a capacity or offer error, choose another region.

## Deploy with the button

The button opens the compiled template from a public URL. Before the first release the URL must point at a public copy of `azuredeploy.json` pinned to a release tag, for example a GitHub release asset or `raw.githubusercontent.com/Polynovea/MellowBase/<tag>/deploy/azure/azuredeploy.json`:

```markdown
[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/<URL-encoded address of azuredeploy.json>)
```

URL-encode the address (`:` → `%3A`, `/` → `%2F`). For Azure Government use `https://portal.azure.us/#create/Microsoft.Template/uri/...` and the `https://aka.ms/deploytoazuregovbutton` image.

In the portal:

1. **Resource group → Create new**, give it a name such as `polynovea`, and choose the **Region**.
2. **Database Mode**: `managed` (recommended; the setup wizard finds the database by itself) or `on-this-server` (cheaper; PostgreSQL on the VM, backed up to the container).
3. **Budget Email**: where Azure sends spending alerts. **Budget Monthly Amount**: the default 70 suits the managed install.
4. **Admin Ssh Public Key**: paste the public key from step 3 above.
5. **Admin Cidr**: your IP address with `/32`. Leave it blank only if you set a domain and never need SSH.
6. **Domain** and **Acme Email**: optional, see "Before you start". Set a domain, an Admin Cidr, or both; with neither, nobody can reach the setup wizard.
7. **Container Image** and **Caddy Image**: the release's link fills these in (pinned by digest). Leave **Database Admin Password**, **Budget Start Date** and **Custom Image Id** as they are.
8. **Review + create**, then **Create**. It takes about 10 to 15 minutes (the database takes longest).

## Deploy from the command line

Preview first: `what-if` shows every change and costs nothing.

```bash
az group create --name polynovea --location eastus
az deployment group what-if --resource-group polynovea --template-file deploy/azure/main.bicep --parameters deploy/azure/main.bicepparam
az deployment group create  --resource-group polynovea --template-file deploy/azure/main.bicep --parameters deploy/azure/main.bicepparam
```

Edit `main.bicepparam` first: replace the example email and SSH key.

## After deployment

The deployment's **Outputs** tab lists:

| Output | What it's for |
| --- | --- |
| `setupAddress` | Where to open the setup wizard |
| `publicIp` | The VM's fixed address. Point your domain's A record here. |
| `setupCode` | Where to read the one-time setup code in the portal |
| `sshTunnel` | The SSH command (with the tunnel when there is no domain), when `adminCidr` is set |
| `databaseSecretRef` | The Key Vault secret's address, set on the VM as `POLYNOVEA_DB_SECRET_REF` (managed only) |
| `databaseHost` | The database's private name; reachable only from the VM |
| `storageAccountName`, `containerName` | Set on the VM as `POLYNOVEA_BACKUP_ACCOUNT` and `POLYNOVEA_BACKUP_CONTAINER`; the wizard suggests them for "On this server" backups |

Then open the setup wizard:

1. **With a domain**, point its A record at `publicIp`. Caddy gets the certificate within a few minutes of that.
2. **Wait for first boot.** On plain Ubuntu it installs updates, Docker and the CMS, which takes several minutes. Progress, over SSH: `sudo journalctl -u polynovea-bootstrap -f`.
3. **Find the setup code.** In the Azure portal: **Virtual machines → `polynovea-vm` → Help → Serial console** (or **Help → Boot diagnostics → Serial log**), and look for the line with "Setup code". It appears a few minutes after the VM starts (refresh if it isn't there yet), and only until setup is finished. It works once and expires after an hour. Anyone in this subscription who can read the VM's serial console can see it during that time. Over SSH (`ssh -i <your .pem file> polynovea@<publicIp>`): `sudo journalctl -t polynovea | grep -i "setup code"`.
4. **Open the wizard** at `setupAddress`: `https://<domain>/setup`, or, without a domain, `http://localhost:3000/setup` while the `sshTunnel` command is running.
5. **Database step.** With `managed`, choose **Created for you**: the wizard reads the secret once through the VM's managed identity, runs its five checks, creates `polynovea_owner` and `polynovea_app`, and runs the migrations. With `on-this-server`, choose **On this server** and the Azure Blob container from the outputs.

### Checklist for the first end-to-end test

- [ ] Deployment succeeds from the button alone, in a fresh resource group.
- [ ] `databaseSecretRef` has the form `https://pnv-<13 characters>.vault.azure.net/secrets/polynovea-database-admin`.
- [ ] On the VM, `/etc/polynovea/polynovea.env` contains no password, `/var/lib/polynovea` is mounted from the data disk (`findmnt /var/lib/polynovea`), and `systemctl status polynovea polynovea-bootstrap` shows the first boot finished.
- [ ] Without a domain, ports 80 and 443 are closed. With one, `https://<domain>/setup` has a valid certificate.
- [ ] The wizard's **Created for you** step passes. A deliberate failure (remove the VM's role assignment on the secret) shows the plain "couldn't read the database secret" message.
- [ ] The database has no public endpoint (**Networking** shows private access) and the lock is present (**Locks**).
- [ ] The VM's identity has exactly two role assignments (**VM → Identity → Azure role assignments**).
- [ ] The budget appears under **Cost Management → Budgets**.
- [ ] `on-this-server`: the wizard's first backup to the container passes.

## Removing it

The locks are there to stop accidents, so removing an install takes deliberate steps. **Deleting the database and storage account deletes your content and backups.** Export anything you need first.

1. **Resource group → Settings → Locks**, delete `polynovea-keep-database` and `polynovea-keep-storage`.
2. Delete the resource group.
3. The Key Vault stays soft-deleted for 90 days (purge protection; it costs nothing). Its name can't be reused until then, so a new deployment into a resource group with the same ID gets a vault-name clash. Use a new resource group name.

## Things that can't be verified without an Azure account

These templates were validated offline only (Bicep build and linter, checkov, and the unit tests in `deploy/templates.test.ts`). Nothing has been deployed. The first real deployment should confirm:

- Key Vault accepts the secret written by Resource Manager while its firewall is set to deny by default, with only the VM's subnet admitted. If it doesn't, set `networkAcls.defaultAction` to `Allow` for the first deployment and report it.
- The Consumption budget deploys on the subscription's offer type.
- The release package's data-disk script finds the data disk at LUN 0, and the first-boot script finishes on plain Ubuntu.
- A published Polynovea community gallery image deploys through `customImageId` with Trusted Launch. Its image definition must have been created with `--features SecurityType=TrustedLaunchSupported`.
- Actual prices in the chosen region.
