# Inputs for the Polynovea CMS VM images (aws.pkr.hcl, azure.pkr.hcl). See docs/self-hosting/vm-images.md.

variable "image_ref" {
  type        = string
  description = "The signed Polynovea CMS container image, pinned by digest: registry/name@sha256:<64 hex>. Verify its signature on the release machine before building; the VM image pulls exactly this digest."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$", var.image_ref))
    error_message = "The image_ref must be pinned by digest (name@sha256:<64 hex characters>)."
  }
}

variable "caddy_image_ref" {
  type        = string
  default     = "caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
  description = "Caddy (HTTPS in front of the CMS when a domain is set), pinned by digest."
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.caddy_image_ref))
    error_message = "The caddy_image_ref must be pinned by digest."
  }
}

variable "release_id" {
  type        = string
  description = "The release this VM image carries, e.g. 0.4.0+abc1234. Used in the image names and tags."
  validation {
    condition     = can(regex("^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$", var.release_id))
    error_message = "The release_id may hold letters, digits, dots, plus, underscore and hyphen only."
  }
}

variable "arch" {
  type        = string
  default     = "amd64"
  description = "CPU architecture: amd64, or arm64 (AWS Graviton such as t4g, Azure Ampere)."
  validation {
    condition     = contains(["amd64", "arm64"], var.arch)
    error_message = "The arch must be amd64 or arm64."
  }
}

# ---- AWS ----

variable "aws_region" {
  type    = string
  default = "eu-west-1"
}

variable "aws_instance_type" {
  type        = string
  default     = ""
  description = "Build instance type. Empty picks t3.small (amd64) or t4g.small (arm64)."
}

variable "aws_publishable" {
  type        = bool
  default     = false
  description = "true: build the AMI with an unencrypted root snapshot, so it can be shared or made public (an AMI whose snapshot uses the AWS-managed EBS key cannot be). Instances launched from it must encrypt their volumes at launch (the templates set Encrypted: true). false: encrypted with the account's default key, for private use in this account only."
}

variable "aws_ami_regions" {
  type        = list(string)
  default     = []
  description = "Other regions to copy the AMI to."
}

# ---- Azure ----

variable "azure_subscription_id" {
  type        = string
  default     = ""
  description = "Subscription to build in. Empty uses the Azure CLI's current subscription."
}

variable "azure_location" {
  type    = string
  default = "westeurope"
}

variable "azure_resource_group" {
  type        = string
  default     = "polynovea-images"
  description = "Existing resource group that receives the managed image."
}

# Optional Azure Compute Gallery destination, for publishing (a managed image alone cannot leave its
# subscription). The gallery and its image definition must exist; community sharing is a property of
# the gallery, set when it is created (docs/self-hosting/vm-images.md, "Publishing").
variable "azure_gallery_name" {
  type        = string
  default     = ""
  description = "Gallery to publish an image version into. Empty: managed image only."
}

variable "azure_gallery_resource_group" {
  type    = string
  default = ""
}

variable "azure_gallery_image_name" {
  type        = string
  default     = "polynovea-cms"
  description = "The gallery image definition (one per architecture, e.g. polynovea-cms-arm64)."
}

variable "azure_gallery_image_version" {
  type        = string
  default     = ""
  description = "Gallery image version, major.minor.patch (e.g. 0.4.0)."
  validation {
    condition     = var.azure_gallery_image_version == "" || can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.azure_gallery_image_version))
    error_message = "The azure_gallery_image_version must be major.minor.patch."
  }
}

variable "azure_gallery_regions" {
  type        = list(string)
  default     = []
  description = "Regions to replicate the gallery image version to (the build location is always included)."
}

variable "azure_vm_size" {
  type        = string
  default     = ""
  description = "Build VM size. Empty picks Standard_B2s (amd64) or Standard_B2ps_v2 (arm64)."
}

locals {
  safe_release = replace(var.release_id, "+", "-")
  image_name   = "polynovea-cms-${local.safe_release}-${var.arch}"
}
