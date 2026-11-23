variable "resource_group_name" {
  description = "An existing resource group to create everything in."
  type        = string
}

variable "location" {
  type = string
}

variable "name" {
  description = "Name prefix for resources."
  type        = string
  default     = "polynovea"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.name))
    error_message = "Use 3 to 12 lowercase letters and digits, starting with a letter (it becomes part of the storage account name)."
  }
}

variable "database_mode" {
  description = "managed = Azure Database for PostgreSQL Flexible Server 16 found by the setup wizard (\"Created for you\"); on-this-server = PostgreSQL on the VM's data disk, backed up to the Blob container."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "on-this-server"], var.database_mode)
    error_message = "database_mode must be \"managed\" or \"on-this-server\"."
  }
}

variable "database_sku" {
  type    = string
  default = "B_Standard_B1ms"
}

variable "database_storage_mb" {
  type    = number
  default = 32768
}

variable "budget_email" {
  type = string
}

variable "budget_monthly_amount" {
  type    = number
  default = 70
}

variable "budget_start_date" {
  description = "First day of the budget period, RFC 3339 (for example 2026-12-01T00:00:00Z). Must be the first of a month."
  type        = string
}

variable "admin_ssh_public_key" {
  description = "Your SSH public key. Azure requires one for a Linux VM; it is not a secret."
  type        = string
}

variable "admin_cidr" {
  description = "Blank for no SSH at all, or your own address (x.x.x.x/32). The SSH-tunnel setup route needs it."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_cidr == "" || can(cidrhost(var.admin_cidr, 0))
    error_message = "admin_cidr must be blank or an IPv4 range such as 203.0.113.7/32."
  }
}

variable "operator_ip_ranges" {
  description = "Public IPv4 addresses or ranges of the machine running OpenTofu. OpenTofu writes the database secret through Key Vault's data plane, so Key Vault's firewall must admit it. The VM's subnet is always admitted."
  type        = list(string)
  default     = []
}

variable "vm_size" {
  type    = string
  default = "Standard_B2s"
}

variable "architecture" {
  type    = string
  default = "x64"

  validation {
    condition     = contains(["x64", "arm64"], var.architecture)
    error_message = "architecture must be x64 or arm64."
  }
}

variable "data_disk_gb" {
  type    = number
  default = 32
}

variable "container_image" {
  description = "Polynovea CMS image pinned by digest (name@sha256:...). Required on plain Ubuntu; blank on a Polynovea server image uses the image it carries."
  type        = string
  default     = ""

  validation {
    condition     = var.container_image == "" || can(regex("^[a-z0-9]([a-z0-9._/:-]*[a-z0-9])?@sha256:[a-f0-9]{64}$", var.container_image))
    error_message = "container_image must be pinned by digest (name@sha256:...), or blank."
  }
}

variable "custom_image_id" {
  description = "Optional Polynovea server image resource ID. Blank = Ubuntu 24.04 LTS."
  type        = string
  default     = ""
}

variable "caddy_image" {
  description = "HTTPS proxy (Caddy) image pinned by digest. Required on plain Ubuntu; blank on a Polynovea server image uses the image it carries."
  type        = string
  default     = ""

  validation {
    condition     = var.caddy_image == "" || can(regex("^[a-z0-9]([a-z0-9._/:-]*[a-z0-9])?@sha256:[a-f0-9]{64}$", var.caddy_image))
    error_message = "caddy_image must be pinned by digest (name@sha256:...), or blank."
  }
}

variable "domain" {
  description = "Your domain, for example cms.example.com. With it, Caddy gets a Let's Encrypt certificate once the A record points at public_ip, and setup is at https://<domain>/setup. Without it, ports 80/443 stay closed and setup goes through the SSH tunnel (needs admin_cidr)."
  type        = string
  default     = ""

  validation {
    condition     = var.domain == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain))
    error_message = "domain must be blank or a lowercase domain name."
  }
}

variable "acme_email" {
  description = "Optional. Let's Encrypt may email this address about the certificate."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
