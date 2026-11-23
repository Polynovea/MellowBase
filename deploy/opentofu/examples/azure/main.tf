# Example root module: Polynovea CMS on Azure with OpenTofu.
#
# State encryption is REQUIRED, not optional: state holds the generated database password. Every
# state and plan file is encrypted with AES-GCM under a key wrapped by your own Azure Key Vault key
# (a separate vault from the CMS's), and `enforced = true` makes OpenTofu refuse to write either
# unencrypted. State lives in your own storage account; nothing goes to Polynovea.
#
#   az login                           # OpenTofu uses your Azure CLI sign-in
#   tofu init
#   tofu plan -out polynovea.plan      # read the plan before every apply
#   tofu apply polynovea.plan

terraform {
  required_version = ">= 1.10.0"

  backend "azurerm" {
    resource_group_name  = var.state_resource_group
    storage_account_name = var.state_storage_account
    container_name       = "tfstate"
    key                  = "polynovea.tfstate"
    use_azuread_auth     = true
  }

  encryption {
    key_provider "azure_vault" "state" {
      vault_uri      = var.state_vault_uri
      vault_key_name = var.state_vault_key_name
      key_length     = 32
    }

    method "aes_gcm" "state" {
      keys = key_provider.azure_vault.state
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
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.20, < 5.0"
    }
  }
}

variable "subscription_id" {
  type = string
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "resource_group_name" {
  description = "An existing, empty resource group for the CMS."
  type        = string
}

variable "state_resource_group" {
  type = string
}

variable "state_storage_account" {
  type = string
}

variable "state_vault_uri" {
  description = "https://<vault-name>.vault.azure.net/ - a Key Vault you own, separate from the CMS's."
  type        = string
}

variable "state_vault_key_name" {
  description = "An RSA key in that vault, used only to wrap OpenTofu's state key."
  type        = string
}

variable "budget_email" {
  type = string
}

variable "budget_start_date" {
  description = "First day of this month, for example 2026-12-01T00:00:00Z."
  type        = string
}

variable "admin_ssh_public_key" {
  type = string
}

variable "operator_ip_ranges" {
  description = "Your public IPv4 address, so OpenTofu can write the database secret into Key Vault."
  type        = list(string)
}

provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}

module "polynovea" {
  source = "../../modules/azure"

  resource_group_name  = var.resource_group_name
  location             = var.location
  database_mode        = "managed"
  budget_email         = var.budget_email
  budget_start_date    = var.budget_start_date
  admin_ssh_public_key = var.admin_ssh_public_key
  operator_ip_ranges   = var.operator_ip_ranges
}

output "polynovea" {
  value = module.polynovea
}
