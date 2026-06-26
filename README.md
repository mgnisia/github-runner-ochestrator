# GitHub Ephemeral Runner Orchestrator

An AWS CDK + TypeScript project that receives GitHub webhooks via API Gateway v2 (HTTP API) and validates them using an HMAC-SHA256 signature stored in AWS SSM Parameter Store.

## Prerequisites

- Node.js v18+ and npm
- AWS CDK CLI v2: `npm install -g aws-cdk`
- AWS credentials configured for the target account/region (only required for `cdk deploy`, not `cdk synth`)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the SSM SecureString parameter (required before deploy)

The HMAC shared secret is stored in SSM Parameter Store as a SecureString. CloudFormation cannot create SecureString parameters, so you must create it manually before deploying:

```bash
aws ssm put-parameter \
  --name /github-runner-orchestrator/webhook-secret \
  --type SecureString \
  --value "<your-shared-hmac-secret>"
```

To use a custom parameter name, override it with CDK context:

```bash
npx cdk synth -c webhookSecretParamName=/my/custom/path
```

### 3. Synthesize the CloudFormation template

```bash
npx cdk synth
# or
npm run synth
```

### 4. Deploy to AWS

```bash
npx cdk deploy
# or
npm run deploy
```

After deployment, the stack outputs two values:
- **WebhookUrl**: The `POST /webhook` endpoint URL to configure in GitHub.
- **WebhookSecretParamName**: The SSM parameter name holding the shared secret.

### 5. Configure GitHub

1. In your GitHub repository or organization, go to **Settings → Webhooks → Add webhook**.
2. Set **Payload URL** to the `WebhookUrl` output value.
3. Set **Content type** to `application/json`.
4. Set **Secret** to the same value you stored in SSM.
5. Choose which events to send (or select **Send me everything**).

## Development

```bash
# Type-check without emitting
npm run build

# Run tests
npm test

# Synthesize template
npm run synth
```

## Architecture

- **API Gateway v2 (HTTP API)**: Accepts `POST /webhook` from GitHub.
- **Lambda (Orchestrator)**: Loads the HMAC secret from SSM at cold start, verifies the `X-Hub-Signature-256` header, filters `workflow_job` events for `action == "queued"` and the `lambda-microvms` label, retrieves JIT runner credentials from GitHub, logs `encoded_jit_config`, and returns `202`. Non-matching events return `200 ignored`. Invalid/missing signature returns `401`. SSM load failure returns `500`.
- **SSM SecureString (webhook secret)**: Holds the shared webhook secret. Referenced (not created) by the stack.
- **SSM SecureString (app credentials)**: Holds the GitHub App credentials as a JSON object. Referenced (not created) by the stack.

---

## Phase 2: Event filtering and JIT runner credential retrieval

### GitHub App credentials parameter

The orchestrator reads GitHub App credentials from a second SSM SecureString at
`/github-runner-orchestrator/app-credentials` (default). The value must be a JSON object:

```json
{
  "appClientId": "Iv1.abc123",
  "installationId": "12345678",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
}
```

The PEM newlines must be JSON-escaped as `\n`. A safe way to create this parameter from a key file:

```bash
PRIVATE_KEY=$(jq -Rs . < /path/to/private-key.pem)
aws ssm put-parameter \
  --name /github-runner-orchestrator/app-credentials \
  --type SecureString \
  --value "{\"appClientId\":\"Iv1.abc123\",\"installationId\":\"12345678\",\"privateKey\":${PRIVATE_KEY}}"
```

### CDK context overrides

| Context key               | Default                                          | Description                             |
|---------------------------|--------------------------------------------------|-----------------------------------------|
| `appCredentialsParamName` | `/github-runner-orchestrator/app-credentials`    | SSM path to the GitHub App credentials  |
| `runnerGroupId`           | `1`                                              | GitHub runner group ID                  |
| `requiredRunnerLabel`     | `lambda-microvms`                                | Label a job must carry to trigger a JIT runner |

Example:
```bash
npx cdk deploy \
  -c appCredentialsParamName=/my/app-creds \
  -c runnerGroupId=2 \
  -c requiredRunnerLabel=lambda-microvms
```

### Filtering behaviour

The handler processes only `workflow_job` webhooks where:
- `action == "queued"` **and**
- `workflow_job.labels` contains the required label (default: `lambda-microvms`).

All other events (wrong type, wrong action, missing label) are logged with a clear reason and
acknowledged with `200 ignored` — no runner work is performed.

### Stack outputs (Phase 2)

After deployment, the stack outputs three values:
- **WebhookUrl**: The `POST /webhook` endpoint URL to configure in GitHub.
- **WebhookSecretParamName**: The SSM parameter name holding the shared HMAC secret.
- **AppCredentialsParamName**: The SSM parameter name holding the GitHub App credentials.

---

## Phase 2.5: MicroVM image encapsulation in CDK

### MicroVM runtime source (`microvm/`)

The `microvm/` directory contains the source files that are zipped into `app.zip` and uploaded to S3 at deploy time:

| File | Description |
|---|---|
| `Dockerfile` | Ubuntu 24.04-based image with Node.js 22, the GitHub Actions runner, and a Python tool cache |
| `app.js` | Lifecycle hook server — handles `/ready`, `/run`, and `/terminate` hooks on ports 8080 and 9000 |
| `entrypoint.sh` | Shell script that passes `ENCODED_JIT_CONFIG` to `run.sh --jitconfig` |
| `package.json` | NPM manifest declaring `@aws-sdk/client-lambda-microvms` as the sole runtime dependency |

At synth time, CDK runs `zip -r app.zip .` (via local bundling) in the `microvm/` directory and uploads the resulting archive to the MicroVM code S3 bucket.

### MicroVM code S3 bucket

A dedicated `AWS::S3::Bucket` (`MicrovmCodeBucket`) holds `app.zip`. Its removal policy is the CDK default (RETAIN), so it persists after stack deletion. The bucket name is emitted as the `MicrovmCodeBucketName` stack output.

### IAM roles

Two IAM roles are created and managed by the CDK stack:

**MicrovmBuildRole** — assumed by Lambda during the `AWS::Lambda::MicrovmImage` build phase:
- Read access to the code bucket (granted via `bucket.grantRead`, to pull `app.zip`)
- `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `arn:{partition}:logs:*:*:*`

**MicrovmExecutionRole** — assumed by each MicroVM instance at runtime:
- `lambda:TerminateMicrovm` on the MicroVM image ARN (so `app.js` can self-terminate after the runner exits)
- `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `*`

### L1 MicrovmImage construct (`lib/microvm-image.ts`)

`MicrovmImage` wraps the `AWS::Lambda::MicrovmImage` CloudFormation resource type. It accepts:

| Prop | Description |
|---|---|
| `buildRoleArn` | ARN of the build role |
| `codeArtifactUri` | `s3://bucket/app.zip` URI |
| `baseImageArn` | ARN of the base MicroVM image (from `MICROVM_BASE_IMAGE_ARN`) |
| `baseImageVersion` | Version string for the base image (from `MICROVM_BASE_IMAGE_VERSION`) |
| `egressConnectorArn` | Region/partition-derived egress network connector ARN |

It exposes `imageArn` (resolved from `Fn::GetAtt`) which is wired into the orchestrator Lambda's environment and IAM policies.

### Required environment variables

These must be set before running `cdk synth` or `cdk deploy`:

| Variable | Description | Example |
|---|---|---|
| `MICROVM_BASE_IMAGE_ARN` | ARN of the AWS-provided MicroVM base image | `arn:aws:lambda:eu-west-1:739178438747:microvm-base-image:al2023` |
| `MICROVM_BASE_IMAGE_VERSION` | Version of the base image | `1` |

```bash
export MICROVM_BASE_IMAGE_ARN=arn:aws:lambda:eu-west-1:739178438747:microvm-base-image:al2023
export MICROVM_BASE_IMAGE_VERSION=1
npx cdk synth
```

If either variable is unset, `cdk synth` fails immediately with a clear error message.

### Network connectors

Ingress and egress network connector ARNs are derived from the stack's region and partition at synth time — no CDK context overrides are needed:

```
arn:{partition}:lambda:{region}:aws:network-connector:aws-network-connector:NO_INGRESS
arn:{partition}:lambda:{region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS
```

---

> **SECURITY — `encoded_jit_config` logging:** The JIT runner registration credential
> (`encoded_jit_config`) is currently logged to CloudWatch **only** for the Phase 2 confirmation
> phase. This logging **must be removed before this stack is used in production**. Removal is
> tracked in beads issue `github-runner-ochestrator-q1h`. The App private key and installation
> token are never logged.
