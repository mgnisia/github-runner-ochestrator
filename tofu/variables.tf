variable "aws_region" {
  description = "AWS region to deploy into. Must be a region where Lambda MicroVMs are available (e.g. eu-west-1, us-east-1). Note: eu-central-1 does NOT support MicroVMs."
  type        = string
  default     = "eu-west-1"
}

variable "aws_profile" {
  description = "Named AWS CLI/SDK profile to use for credentials (the dev account)."
  type        = string
  default     = "default"
}

variable "webhook_secret_param_name" {
  description = "SSM SecureString parameter holding the GitHub webhook HMAC secret. Referenced, never created (SecureStrings must be created out-of-band)."
  type        = string
  default     = "/github-runner-orchestrator/webhook-secret"
}

variable "app_credentials_param_name" {
  description = "SSM SecureString parameter holding the GitHub App credentials JSON. Referenced, never created."
  type        = string
  default     = "/github-runner-orchestrator/app-credentials"
}

variable "required_runner_label" {
  description = "workflow_job label that gates whether a runner is provisioned."
  type        = string
  default     = "lambda-microvms"
}

variable "docker_runner_label" {
  description = "Label that selects the Docker-in-Docker MicroVM image flavor."
  type        = string
  default     = "docker"
}

variable "microvm_max_idle_seconds" {
  description = "MicroVM max idle seconds before teardown."
  type        = string
  default     = "1800"
}

variable "microvm_suspended_seconds" {
  description = "MicroVM suspended seconds."
  type        = string
  default     = "10"
}

variable "microvm_max_duration_seconds" {
  description = "MicroVM max total duration seconds."
  type        = string
  default     = "3600"
}

# ── Phase B inputs ────────────────────────────────────────────────────────────
# The orchestrator/worker Lambdas, SQS queues and API Gateway are only created
# once BOTH MicroVM image ARNs are supplied. This mirrors the old CDK two-phase
# deploy: apply once with these empty to create the code bucket + build role,
# build the images, then apply again with both ARNs set.

variable "microvm_image_arn_docker" {
  description = "ARN of the github-runner-docker MicroVM image. Empty until built."
  type        = string
  default     = ""
}

variable "microvm_image_arn_no_docker" {
  description = "ARN of the github-runner-no-docker MicroVM image. Empty until built."
  type        = string
  default     = ""
}

variable "runner_group_id" {
  description = "GitHub runner group id the JIT runners register into. Required for Phase B."
  type        = string
  default     = ""
}
