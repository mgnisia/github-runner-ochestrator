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
- **Lambda (Orchestrator)**: Loads the HMAC secret from SSM at cold start, verifies the `X-Hub-Signature-256` header, and logs the payload. Returns `202 Accepted` on valid signatures, `401` on invalid/missing, and `500` if the secret cannot be loaded.
- **SSM SecureString**: Holds the shared webhook secret. Referenced (not created) by the stack.
