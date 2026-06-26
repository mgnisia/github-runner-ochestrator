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

Deployment happens in three steps. `output.json` (stack outputs) and `.env` (image ARN) are generated automatically and are gitignored.

**Step 1 — Deploy infrastructure (bucket + build role)**

```bash
npm run deploy
```

This first deploy intentionally creates only the `MicrovmCodeBucket` and `MicrovmBuildRole`. The orchestrator Lambda and API Gateway are absent because no `MICROVM_IMAGE_ARN` is set yet. Stack outputs are written to `output.json`.

**Step 2 — Build the MicroVM image**

Requires AWS credentials and a completed Step 1:

```bash
npm run build:image
```

This zips `microvm/` into `app.zip`, uploads it to the code bucket, creates (or updates) the `github-runner` MicroVM image, polls until the build is complete, and writes `MICROVM_IMAGE_ARN=<arn>` to `.env`.

**Step 3 — Deploy the orchestrator**

`RUNNER_GROUP_ID` must be set (in `.env` or the environment) for this step:

```bash
export RUNNER_GROUP_ID=1   # or add to .env
npm run deploy
```

Now `.env` provides `MICROVM_IMAGE_ARN`, so CDK also deploys the orchestrator Lambda and API Gateway. After this deploy, the stack outputs include:
- **WebhookUrl**: The `POST /webhook` endpoint URL to configure in GitHub.
- **WebhookSecretParamName**: The SSM parameter name holding the shared HMAC secret.
- **AppCredentialsParamName**: The SSM parameter name holding the GitHub App credentials.

Removing `.env` (or unsetting `MICROVM_IMAGE_ARN`) on a later deploy removes the orchestrator — expected env-driven desired-state behavior.

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
| `requiredRunnerLabel`     | `lambda-microvms`                                | Label a job must carry to trigger a JIT runner |

`cdk.json` no longer carries any per-deployment configuration — all deployment-specific values are supplied via environment variables (see the "Required environment variables" section below).

Example:
```bash
npx cdk deploy \
  -c appCredentialsParamName=/my/app-creds \
  -c requiredRunnerLabel=lambda-microvms
```

### Filtering behaviour

The handler processes only `workflow_job` webhooks where:
- `action == "queued"` **and**
- `workflow_job.labels` contains the required label (default: `lambda-microvms`).

All other events (wrong type, wrong action, missing label) are logged with a clear reason and
acknowledged with `200 ignored` — no runner work is performed.

### Stack outputs (Phase 2)

After the orchestrator deploy (Step 3 above, requires `MICROVM_IMAGE_ARN`), the stack outputs include:
- **WebhookUrl**: The `POST /webhook` endpoint URL to configure in GitHub.
- **WebhookSecretParamName**: The SSM parameter name holding the shared HMAC secret.
- **AppCredentialsParamName**: The SSM parameter name holding the GitHub App credentials.

---

## Phase 2.5: MicroVM image build and two-phase deploy

### MicroVM runtime source (`microvm/`)

The `microvm/` directory contains the source files zipped into `app.zip` and uploaded to S3 by `scripts/build-microvm-image.ts`:

| File | Description |
|---|---|
| `Dockerfile` | Ubuntu 24.04-based image with Node.js 22, the GitHub Actions runner, and a Python tool cache |
| `app.js` | Lifecycle hook server — handles `/ready`, `/run`, and `/terminate` hooks on ports 8080 and 9000 |
| `entrypoint.sh` | Shell script that passes `ENCODED_JIT_CONFIG` to `run.sh --jitconfig` |
| `package.json` | NPM manifest declaring `@aws-sdk/client-lambda-microvms` as the sole runtime dependency |

The zip is created and uploaded by `npm run build:image` — not at CDK synth or deploy time.

### MicroVM code S3 bucket

A dedicated `AWS::S3::Bucket` (`MicrovmCodeBucket`) holds `app.zip`. Its removal policy is the CDK default (RETAIN), so it persists after stack deletion. The bucket name is emitted as the `MicrovmCodeBucketName` stack output.

### IAM roles

Two IAM roles are created and managed by the CDK stack:

**MicrovmBuildRole** — assumed by Lambda during the script-driven MicroVM image build:
- Read access to the code bucket (granted via `bucket.grantRead`, to pull `app.zip`)
- `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `arn:{partition}:logs:*:*:*`

This role is part of Phase A (always synthesized, regardless of `MICROVM_IMAGE_ARN`).

**MicrovmExecutionRole** — assumed by each MicroVM instance at runtime:
- `lambda:TerminateMicrovm` on the MicroVM image ARN (so `app.js` can self-terminate after the runner exits)
- `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `*`

This role is part of Phase B (only synthesized when `MICROVM_IMAGE_ARN` is set).

### MicroVM image build (`scripts/build-microvm-image.ts`)

The `build-microvm-image.ts` script (run via `npm run build:image`) drives the full image creation workflow outside of CloudFormation:

1. Reads `output.json` (written by `npm run deploy`) to obtain the code bucket name, build role ARN, base image ARN, and region.
2. Zips the four files in `microvm/` into `app.zip` and uploads it to the code bucket.
3. Calls CreateMicrovmImage (or UpdateMicrovmImage if `github-runner` already exists) with:
   - Image name: `github-runner`
   - Lifecycle hooks on port `9000`: ready (60 s), run (30 s), terminate (30 s)
   - Service-default values for CPU, resources, and base image version (none set explicitly)
4. Polls until the image status reaches `CREATED` or `UPDATED`.
5. Writes `MICROVM_IMAGE_ARN=<arn>` into `.env` at the repo root.

The `MICROVM_IMAGE_ARN` value in `.env` is then automatically loaded by `dotenv` on the next `npm run deploy`, enabling Phase B of the CDK stack.

> **Why a script instead of CloudFormation?** The `AWS::Lambda::MicrovmImage` resource type does not stabilize within CloudFormation's handler timeout — the ~minutes-long image build exceeds the limit. A dedicated script gives full control over the polling loop and eliminates the timeout risk.

### Base image

The MicroVM base image is an AWS-owned image; its ARN is hardcoded in the stack and requires no environment variable:

- **BaseImageArn**: `arn:{partition}:lambda:{region}:aws:microvm-image:al2023-1` — derived from the stack's region and partition at synth time.

The ARN is emitted as the `MicrovmBaseImageArn` stack output for `npm run build:image` to consume. No base image version is specified — the service default applies.

### Phase A stack outputs (always present)

These outputs are written to `output.json` after every `npm run deploy`:

| Output | Description |
|---|---|
| `MicrovmCodeBucketName` | Name of the S3 bucket holding `app.zip` |
| `MicrovmBuildRoleArn` | ARN of the role passed to the image build |
| `MicrovmBaseImageArn` | ARN of the AWS-owned base image |
| `Region` | AWS region the stack is deployed to |

### Required environment variables

| Variable | Required for | Description | Example |
|---|---|---|---|
| `MICROVM_IMAGE_ARN` | Orchestrator deploy (Step 3) | ARN of the built MicroVM image — set automatically by `npm run build:image` into `.env` | `arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner:1` |
| `RUNNER_GROUP_ID` | Orchestrator deploy (Step 3) | GitHub runner group ID the JIT runner registers into | `1` |

`MICROVM_IMAGE_ARN` gates whether CDK synthesizes the orchestrator Lambda and API Gateway. When it is unset, `cdk synth` produces only the Phase A resources (bucket + build role). When set, `RUNNER_GROUP_ID` must also be provided or the synth fails with a clear error.

```bash
# Typical .env for the orchestrator deploy:
MICROVM_IMAGE_ARN=arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner:1
RUNNER_GROUP_ID=1
```

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
