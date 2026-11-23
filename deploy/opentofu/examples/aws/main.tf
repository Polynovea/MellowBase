# Example root module: Polynovea CMS on AWS with OpenTofu.
#
# State encryption is REQUIRED, not optional: state holds the generated database password. Every
# state and plan file is encrypted with AES-GCM under a data key from your own AWS KMS key, and
# `enforced = true` makes OpenTofu refuse to write either unencrypted. State lives in your own S3
# bucket; nothing goes to Polynovea.
#
#   tofu init
#   tofu plan -out polynovea.plan      # read the plan before every apply
#   tofu apply polynovea.plan

terraform {
  required_version = ">= 1.10.0"

  backend "s3" {
    bucket       = var.state_bucket
    key          = "polynovea/terraform.tfstate"
    region       = var.region
    encrypt      = true
    use_lockfile = true
  }

  encryption {
    key_provider "aws_kms" "state" {
      kms_key_id = var.state_kms_key_id
      region     = var.region
      key_spec   = "AES_256"
    }

    method "aes_gcm" "state" {
      keys = key_provider.aws_kms.state
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "region" {
  description = "AWS region for the CMS and the state bucket."
  type        = string
}

variable "state_bucket" {
  description = "An existing S3 bucket you own for OpenTofu state (versioned, not public)."
  type        = string
}

variable "state_kms_key_id" {
  description = "ARN or alias of an existing KMS key you own, used only to encrypt OpenTofu state and plans."
  type        = string
}

variable "budget_email" {
  type = string
}

provider "aws" {
  region = var.region
}

module "polynovea" {
  source = "../../modules/aws"

  name          = "polynovea"
  database_mode = "managed"
  budget_email  = var.budget_email
}

output "polynovea" {
  value = module.polynovea
}
