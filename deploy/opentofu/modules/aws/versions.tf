terraform {
  # 1.11.0 is the first OpenTofu with ephemeral resources and write-only attributes
  # (https://opentofu.org/docs/language/ephemerality/), which keep the database password out of
  # state and plan files.
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0" # password_wo / secret_string_wo exist from 5.90 (in 6.x since 6.0)
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7, < 4.0" # ephemeral random_password from 3.7.0
    }
  }
}
