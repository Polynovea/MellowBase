# Polynovea CMS with OpenTofu

`modules/aws` and `modules/azure` create the same resources as the CloudFormation and Bicep templates (see [../aws/README.md](../aws/README.md) and [../azure/README.md](../azure/README.md) for what each resource does and costs). `examples/` shows the root module you write around them.

## State encryption is required

OpenTofu state holds every resource's attributes, including the generated database password. So the examples turn on OpenTofu's [state encryption](https://opentofu.org/docs/language/state/encryption/) for both state and plan files, with `enforced = true`: OpenTofu refuses to write either unencrypted, and a misconfiguration fails loudly instead of silently writing plain text.

| Cloud | Key provider | You create first |
| --- | --- | --- |
| AWS | `aws_kms`: a data key from your own KMS key, AES-GCM | A KMS key (about US$1/month) and a private, versioned S3 bucket for state |
| Azure | `azure_vault`: a key wrapped by your own Key Vault key, AES-GCM | A Key Vault with an RSA key, separate from the CMS's vault, and a storage account with a `tfstate` container |

Keep the state key separate from the install: deleting the install must never delete the key that opens its state.

## Using it

```bash
cd deploy/opentofu/examples/aws          # or azure
tofu init
tofu plan -out polynovea.plan            # read the plan before every apply
tofu apply polynovea.plan
```

Set the example's variables in a `terraform.tfvars` file that you don't commit. On Azure, also set `operator_ip_ranges` to your own public address: OpenTofu writes the database secret through Key Vault's data plane, and Key Vault's firewall admits only the VM's subnet and the addresses you list.

**After the first apply on Azure, take your own access away again.** The module gave the account running OpenTofu **Key Vault Secrets Officer** on the vault (`operator_writes_secret`), and your address is in the vault's and the storage account's firewalls. Neither is needed once the secret is written. Set `operator_ip_ranges = []`, then plan and apply. Remove the role assignment in the portal (**Key vault → Access control (IAM) → Role assignments →** your account, **Key Vault Secrets Officer → Remove**), or with `az role assignment delete --assignee <your object ID> --role "Key Vault Secrets Officer" --scope <vault ID>`. A later apply that changes the secret needs both again, briefly.

### In an account shared with other work

The defaults suit an account of its own. Every resource gets the tag `Project=<project_tag>` (default `MellowBase`), merged after your own `tags` so they can't replace it. On AWS the budget counts only costs with that tag: activate `Project` as a cost allocation tag in AWS Billing first, or the budget counts nothing (steps in [../aws/README.md](../aws/README.md#in-an-aws-account-shared-with-other-work)). On Azure the budget belongs to the resource group, so it counts that group only. `name` is the name prefix (default `polynovea`, the names earlier versions gave): set it, for example to `mellowbase`, on the first apply and keep it, because the database's name includes it.

## Protection against deletion

The database, the bucket or storage account and the data disk have `prevent_destroy = true`, so `tofu destroy` stops before touching them. The AWS database also has deletion protection, and the Azure database, storage account and data disk have delete locks (`polynovea-keep-database`, `polynovea-keep-storage`, `polynovea-keep-data-disk`). To remove an install deliberately: export your content, remove the `prevent_destroy` lines, turn off deletion protection or remove the locks, then plan and apply.

## Cost of a plan

[Infracost](https://www.infracost.io/) can price a plan before you apply it. It isn't bundled here because its licence hasn't been reviewed yet.

## Differences from the templates

- **AWS:** OpenTofu generates the database password (`random_password`, 40 letters and digits) and writes the full secret, host included, itself. CloudFormation uses Secrets Manager's generator and a secret attachment instead. Both secrets have the same shape.
- **Azure:** OpenTofu generates the password with `random_password` (upper case, lower case and digits), not `newGuid()`.
- **Names:** OpenTofu has no `uniqueString()`, so names end in 10 characters of a hash of the resource group's ID. The Key Vault is `pnv-<10 random characters>`, made once per install and kept in state, so a fresh install into the same resource group never collides with a vault Azure is still holding (deleted vaults keep their name for 90 days). Bicep does the same with its `installId` parameter.
