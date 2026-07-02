terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Partial backend config: the state bucket + region are NOT hardcoded here.
  # They are supplied at `tofu init` time from the gitignored .env file via
  # -backend-config flags (see scripts/tofu.ts, which reads TF_STATE_BUCKET /
  # TF_STATE_REGION). Static, non-secret settings stay inline.
  backend "s3" {
    key          = "github-runner-orchestrator/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "github-runner-orchestrator"
      ManagedBy = "opentofu"
    }
  }
}
