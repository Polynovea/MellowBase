terraform {
  # 1.11.0 is the first OpenTofu with ephemeral resources and write-only attributes
  # (https://opentofu.org/docs/language/ephemerality/), which keep the database password out of
  # state and plan files.
  required_version = ">= 1.11.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.30, < 5.0" # administrator_password_wo / value_wo present at 4.30.0
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7, < 4.0" # ephemeral random_password from 3.7.0
    }
  }
}
