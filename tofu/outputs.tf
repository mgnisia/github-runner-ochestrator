# ── Phase A outputs (always available) ─────────────────────────────────────
# Consumed by scripts/build-microvm-image.ts via `tofu output -json`.
output "microvm_code_bucket_name" {
  description = "S3 bucket the MicroVM build service pulls code artifacts from."
  value       = aws_s3_bucket.microvm_code.bucket
}

output "microvm_build_role_arn" {
  description = "IAM role assumed by the MicroVM image build service."
  value       = aws_iam_role.microvm_build.arn
}

output "microvm_base_image_arn" {
  description = "AWS-owned base MicroVM image ARN."
  value       = local.base_image_arn
}

output "region" {
  description = "Deployment region."
  value       = local.region
}

# ── Phase B outputs (null until both image ARNs are set) ────────────────────
output "webhook_url" {
  description = "Public POST endpoint GitHub sends webhooks to."
  value       = local.phase_b ? "${aws_apigatewayv2_api.webhook[0].api_endpoint}/webhook" : null
}

output "webhook_secret_param_name" {
  description = "SSM SecureString name for the webhook HMAC secret."
  value       = var.webhook_secret_param_name
}

output "app_credentials_param_name" {
  description = "SSM SecureString name for the GitHub App credentials."
  value       = var.app_credentials_param_name
}

output "microvm_image_arn_docker" {
  description = "Docker MicroVM image ARN in use."
  value       = local.phase_b ? var.microvm_image_arn_docker : null
}

output "microvm_image_arn_no_docker" {
  description = "No-Docker MicroVM image ARN in use."
  value       = local.phase_b ? var.microvm_image_arn_no_docker : null
}

output "queue_url" {
  description = "Webhook SQS queue URL."
  value       = local.phase_b ? aws_sqs_queue.webhook[0].url : null
}

output "dlq_url" {
  description = "Webhook dead-letter queue URL."
  value       = local.phase_b ? aws_sqs_queue.webhook_dlq[0].url : null
}
