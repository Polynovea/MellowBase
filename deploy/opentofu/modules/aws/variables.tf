variable "name" {
  description = "Name prefix for every resource, like a CloudFormation stack name."
  type        = string
  default     = "polynovea"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.name))
    error_message = "Use 3 to 32 lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "database_mode" {
  description = "managed = RDS PostgreSQL 16 found by the setup wizard (\"Created for you\"); on-this-server = PostgreSQL on the server's data disk, backed up to the bucket."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "on-this-server"], var.database_mode)
    error_message = "database_mode must be \"managed\" or \"on-this-server\"."
  }
}

variable "database_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "postgres_version" {
  description = "A PostgreSQL 16 minor version RDS can create (the bare \"16\" is no longer accepted). Each release bumps the default; automatic minor upgrades keep it patched after that."
  type        = string
  default     = "16.15"

  validation {
    condition     = can(regex("^16\\.[0-9]+$", var.postgres_version))
    error_message = "postgres_version must be a PostgreSQL 16 minor version, such as 16.15."
  }
}

variable "database_storage_gb" {
  type    = number
  default = 20

  validation {
    condition     = var.database_storage_gb >= 20 && var.database_storage_gb <= 1000
    error_message = "database_storage_gb must be between 20 and 1000."
  }
}

variable "budget_email" {
  description = "AWS emails this address when spending passes 80% of the budget, or is forecast to pass 100%."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "Enter an email address."
  }
}

variable "budget_monthly_usd" {
  type    = number
  default = 50
}

variable "instance_type" {
  description = "t4g sizes are arm64 (cheaper), t3 sizes are amd64."
  type        = string
  default     = "t4g.small"
}

variable "architecture" {
  description = "arm64 for Graviton sizes (t4g), amd64 for Intel/AMD sizes (t3)."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "amd64"], var.architecture)
    error_message = "architecture must be arm64 or amd64."
  }
}

variable "data_volume_gb" {
  description = "The separate disk mounted at /var/lib/polynovea."
  type        = number
  default     = 20
}

variable "domain" {
  description = "Your domain, for example cms.example.com. With it, Caddy gets a Let's Encrypt certificate once the A record points at public_ip, and setup is at https://<domain>/setup. Without it, ports 80/443 stay closed and setup goes through the SSH tunnel (needs admin_cidr and key_pair_name)."
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

  validation {
    # One address, no spaces or line breaks: it is written into the server's settings file.
    condition     = var.acme_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.acme_email))
    error_message = "acme_email must be blank or one email address."
  }
}

variable "admin_cidr" {
  description = "Blank for no SSH at all, or your own address (x.x.x.x/32) for SSH from it only. The SSH-tunnel setup route needs it."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_cidr == "" || can(cidrhost(var.admin_cidr, 0))
    error_message = "admin_cidr must be blank or an IPv4 range such as 203.0.113.7/32."
  }
}

variable "key_pair_name" {
  description = "An existing EC2 key pair for SSH. Blank for none."
  type        = string
  default     = ""
}

variable "container_image" {
  description = "Polynovea CMS image pinned by digest (name@sha256:...). Required on plain Ubuntu; blank on a Polynovea server image uses the image it carries."
  type        = string
  default     = ""

  validation {
    condition     = var.container_image == "" || can(regex("^ghcr\\.io/polynovea/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$", var.container_image))
    error_message = "container_image must be the Polynovea image from ghcr.io/polynovea/, pinned by digest (name@sha256:...), or blank."
  }
}

variable "caddy_image" {
  description = "HTTPS proxy (Caddy) image pinned by digest. Required on plain Ubuntu; blank on a Polynovea server image uses the image it carries."
  type        = string
  default     = ""

  validation {
    condition     = var.caddy_image == "" || can(regex("^(docker\\.io/library/)?caddy@sha256:[a-f0-9]{64}$", var.caddy_image))
    error_message = "caddy_image must be Caddy's official image pinned by digest (caddy@sha256:...), or blank."
  }
}

variable "custom_image_id" {
  description = "Optional: the release's published Polynovea AMI for this region (release notes). Blank = Ubuntu 24.04 LTS from Canonical's public SSM parameter."
  type        = string
  default     = ""

  validation {
    condition     = var.custom_image_id == "" || can(regex("^ami-[0-9a-f]{8,17}$", var.custom_image_id))
    error_message = "custom_image_id must be an AMI ID (ami-...), or blank."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
