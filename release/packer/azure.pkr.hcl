# Polynovea CMS Azure managed image: Ubuntu 24.04 LTS + Docker + the signed CMS image.
# Build from a release machine signed in with `az login` (never from GitHub Actions):
#   packer init release/packer
#   packer build -only='polynovea-azure.*' -var-file=release.pkrvars.hcl release/packer
#
# IMDS: Azure's instance metadata service already refuses requests without a `Metadata: true` header
# and requests carrying X-Forwarded-For, so there is no IMDSv2-style switch to turn on.
# See docs/self-hosting/vm-images.md.

locals {
  azure_vm_size = var.azure_vm_size != "" ? var.azure_vm_size : (var.arch == "arm64" ? "Standard_B2ps_v2" : "Standard_B2s")
}

source "azure-arm" "polynovea" {
  use_azure_cli_auth = true
  subscription_id    = var.azure_subscription_id

  os_type         = "Linux"
  image_publisher = "Canonical"
  image_offer     = "ubuntu-24_04-lts"
  image_sku       = var.arch == "arm64" ? "server-arm64" : "server"
  location        = var.azure_location
  vm_size         = local.azure_vm_size

  managed_image_name                = "${local.image_name}-{{timestamp}}"
  managed_image_resource_group_name = var.azure_resource_group

  azure_tags = {
    "polynovea-release-id" = var.release_id
    "polynovea-image-ref"  = var.image_ref
  }
}

build {
  name    = "polynovea-azure"
  sources = ["source.azure-arm.polynovea"]

  provisioner "file" {
    source      = "${path.root}/files/"
    destination = "/tmp/polynovea-files"
  }

  provisioner "file" {
    source      = "${path.root}/../../docker/Caddyfile"
    destination = "/tmp/polynovea-files/Caddyfile"
  }

  provisioner "shell" {
    execute_command = "sudo -E sh -eux '{{ .Path }}'"
    environment_vars = [
      "POLYNOVEA_IMAGE_REF=${var.image_ref}",
      "POLYNOVEA_CADDY_IMAGE_REF=${var.caddy_image_ref}",
      "POLYNOVEA_RELEASE_ID=${var.release_id}",
      "POLYNOVEA_CLOUD=azure",
    ]
    script = "${path.root}/provision.sh"
  }

  # Generalise the VM so Azure can make an image from it (removes the build user and machine identity).
  provisioner "shell" {
    execute_command = "sudo -E sh -eux '{{ .Path }}'"
    inline          = ["/usr/sbin/waagent -force -deprovision+user", "sync"]
  }
}
