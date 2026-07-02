# ── Phase B ────────────────────────────────────────────────────────────────
# Everything below is created only when both MicroVM image ARNs are set
# (local.phase_b). Mirrors the old CDK Phase B block.

# ── Lambda artifacts (built by `bun run build:lambdas` into dist/) ─────────────
data "archive_file" "orchestrator" {
  count       = local.phase_b ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../dist/orchestrator"
  output_path = "${path.module}/../dist/orchestrator.zip"
}

data "archive_file" "worker" {
  count       = local.phase_b ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../dist/worker"
  output_path = "${path.module}/../dist/worker.zip"
}

# ── MicroVM execution role (assumed by the MicroVM at runtime) ─────────────────
resource "aws_iam_role" "microvm_execution" {
  count       = local.phase_b ? 1 : 0
  name_prefix = "microvm-exec-"

  # TODO VERIFY AT DEPLOY: confirm the correct service principal for the MicroVM runtime.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "microvm_execution" {
  count = local.phase_b ? 1 : 0
  name  = "microvm-exec-policy"
  role  = aws_iam_role.microvm_execution[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["lambda:TerminateMicrovm"]
        Resource = [var.microvm_image_arn_docker, var.microvm_image_arn_no_docker]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "*"
      },
    ]
  })
}

# ── SQS queues ─────────────────────────────────────────────────────────────
resource "aws_sqs_queue" "webhook_dlq" {
  count                     = local.phase_b ? 1 : 0
  name_prefix               = "github-runner-webhook-dlq-"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "webhook" {
  count       = local.phase_b ? 1 : 0
  name_prefix = "github-runner-webhook-"
  # 60s (> worker timeout 25s) so a launch retries ~once a minute; with
  # maxReceiveCount=10 that's ~10 min of retries — long enough to ride out the
  # transient 8GB overlap while a prior job's MicroVM finishes terminating.
  visibility_timeout_seconds = 60

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.webhook_dlq[0].arn
    maxReceiveCount     = 10
  })
}

# ── Orchestrator (receiver) Lambda ─────────────────────────────────────────
resource "aws_iam_role" "orchestrator" {
  count       = local.phase_b ? 1 : 0
  name_prefix = "github-runner-orch-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "orchestrator_basic" {
  count      = local.phase_b ? 1 : 0
  role       = aws_iam_role.orchestrator[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "orchestrator" {
  count = local.phase_b ? 1 : 0
  name  = "orchestrator-policy"
  role  = aws_iam_role.orchestrator[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory"]
        Resource = local.webhook_secret_arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.webhook[0].arn
      },
    ]
  })
}

resource "aws_lambda_function" "orchestrator" {
  count            = local.phase_b ? 1 : 0
  function_name    = "github-runner-orchestrator"
  role             = aws_iam_role.orchestrator[0].arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.orchestrator[0].output_path
  source_code_hash = data.archive_file.orchestrator[0].output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      WEBHOOK_SECRET_PARAM  = var.webhook_secret_param_name
      REQUIRED_RUNNER_LABEL = var.required_runner_label
      QUEUE_URL             = aws_sqs_queue.webhook[0].url
    }
  }
}

# ── Worker Lambda ──────────────────────────────────────────────────────────
resource "aws_iam_role" "worker" {
  count       = local.phase_b ? 1 : 0
  name_prefix = "github-runner-worker-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "worker_basic" {
  count      = local.phase_b ? 1 : 0
  role       = aws_iam_role.worker[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "worker" {
  count = local.phase_b ? 1 : 0
  name  = "worker-policy"
  role  = aws_iam_role.worker[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory"]
        Resource = local.app_credentials_arn
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:RunMicrovm"]
        Resource = [var.microvm_image_arn_docker, var.microvm_image_arn_no_docker]
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:PassNetworkConnector"]
        Resource = [local.ingress_connector_arn, local.egress_connector_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = aws_iam_role.microvm_execution[0].arn
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.webhook[0].arn
      },
    ]
  })
}

resource "aws_lambda_function" "worker" {
  count            = local.phase_b ? 1 : 0
  function_name    = "github-runner-worker"
  role             = aws_iam_role.worker[0].arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.worker[0].output_path
  source_code_hash = data.archive_file.worker[0].output_base64sha256
  timeout          = 25
  memory_size      = 256

  environment {
    variables = {
      GITHUB_APP_CREDENTIALS_PARAM       = var.app_credentials_param_name
      RUNNER_GROUP_ID                    = var.runner_group_id
      REQUIRED_RUNNER_LABEL              = var.required_runner_label
      MICROVM_IMAGE_IDENTIFIER_DOCKER    = var.microvm_image_arn_docker
      MICROVM_IMAGE_IDENTIFIER_NO_DOCKER = var.microvm_image_arn_no_docker
      DOCKER_RUNNER_LABEL                = var.docker_runner_label
      MICROVM_EXECUTION_ROLE_ARN         = aws_iam_role.microvm_execution[0].arn
      MICROVM_INGRESS_NETWORK_CONNECTORS = local.ingress_connector_arn
      MICROVM_EGRESS_NETWORK_CONNECTORS  = local.egress_connector_arn
      MICROVM_MAX_IDLE_SECONDS           = var.microvm_max_idle_seconds
      MICROVM_SUSPENDED_SECONDS          = var.microvm_suspended_seconds
      MICROVM_MAX_DURATION_SECONDS       = var.microvm_max_duration_seconds
    }
  }
}

resource "aws_lambda_event_source_mapping" "worker_sqs" {
  count            = local.phase_b ? 1 : 0
  event_source_arn = aws_sqs_queue.webhook[0].arn
  function_name    = aws_lambda_function.worker[0].arn
  batch_size       = 1
}

# ── API Gateway (HTTP API) ─────────────────────────────────────────────────
resource "aws_apigatewayv2_api" "webhook" {
  count         = local.phase_b ? 1 : 0
  name          = "github-runner-webhook"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "webhook" {
  count                  = local.phase_b ? 1 : 0
  api_id                 = aws_apigatewayv2_api.webhook[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.orchestrator[0].invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  count     = local.phase_b ? 1 : 0
  api_id    = aws_apigatewayv2_api.webhook[0].id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.webhook[0].id}"
}

resource "aws_apigatewayv2_stage" "default" {
  count       = local.phase_b ? 1 : 0
  api_id      = aws_apigatewayv2_api.webhook[0].id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw_invoke" {
  count         = local.phase_b ? 1 : 0
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.orchestrator[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook[0].execution_arn}/*/*/webhook"
}
