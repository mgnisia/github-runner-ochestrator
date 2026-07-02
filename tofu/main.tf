data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id

  # Phase B (Lambdas + SQS + API Gateway) is created only when both image ARNs
  # are supplied. Until then, apply creates just the code bucket + build role.
  phase_b = var.microvm_image_arn_docker != "" && var.microvm_image_arn_no_docker != ""

  # AWS-owned base image + network connectors, derived from region/partition.
  base_image_arn        = "arn:${local.partition}:lambda:${local.region}:aws:microvm-image:al2023-1"
  ingress_connector_arn = "arn:${local.partition}:lambda:${local.region}:aws:network-connector:aws-network-connector:NO_INGRESS"
  egress_connector_arn  = "arn:${local.partition}:lambda:${local.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS"

  # SSM SecureString ARNs, reconstructed from the parameter names (referenced,
  # never created by this config).
  webhook_secret_arn  = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${var.webhook_secret_param_name}"
  app_credentials_arn = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${var.app_credentials_param_name}"
}

# ── Phase A: MicroVM code bucket ───────────────────────────────────────────────
# Holds the zipped microvm/ sources the build service pulls during image builds.
# No lifecycle-destroy: matches the CDK default RETAIN removal policy.
resource "aws_s3_bucket" "microvm_code" {
  bucket_prefix = "github-runner-microvm-code-"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "microvm_code" {
  bucket                  = aws_s3_bucket.microvm_code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── Phase A: MicroVM build role ────────────────────────────────────────────────
# Assumed by the MicroVM image build service to read the code artifact from S3.
resource "aws_iam_role" "microvm_build" {
  name_prefix = "microvm-build-"

  # TODO VERIFY AT DEPLOY: confirm the correct service principal for the MicroVM build service.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "microvm_build" {
  name = "microvm-build-policy"
  role = aws_iam_role.microvm_build.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.microvm_code.arn, "${aws_s3_bucket.microvm_code.arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:${local.partition}:logs:*:*:*"
      },
    ]
  })
}
