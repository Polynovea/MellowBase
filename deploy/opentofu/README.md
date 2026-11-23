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

## Protection against deletion

The database, the bucket or storage account and the data disk have `prevent_destroy = true`, so `tofu destroy` stops before touching them. The AWS database also has deletion protection, and the Azure database and storage account have delete locks. To remove an install deliberately: export your content, remove the `prevent_destroy` lines, turn off deletion protection or remove the locks, then plan and apply.

## Cost of a plan

[Infracost](https://www.infracost.io/) can price a plan before you apply it. It isn't bundled here because its licence hasn't been reviewed yet.

## Differences from the templates

- **AWS:** OpenTofu generates the database password (`random_password`, 40 letters and digits) and writes the full secret, host included, itself. CloudFormation uses Secrets Manager's generator and a secret attachment instead. Both secrets have the same shape.
- **Azure:** OpenTofu generates the password with `random_password` (upper case, lower case and digits), not `newGuid()`.
- **Names:** OpenTofu has no `uniqueString()`, so names end in 10 characters of a hash of the resource group's ID. The Key Vault is `pnv-<10 characters>`.
