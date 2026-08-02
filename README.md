# GitHub Ephemeral Runner Orchestrator

This project runs **ephemeral, single-use [GitHub Actions self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners) on [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html), provisioned on demand by a [GitHub webhook](https://docs.github.com/en/webhooks/about-webhooks).**

When a workflow needs a runner, GitHub sends a [`workflow_job`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_job) webhook. The orchestrator validates it, and a fresh MicroVM is launched that registers itself with GitHub as a [just-in-time (JIT) runner](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-an-organization), runs exactly one job, and is then destroyed. There are no long-lived runners, no shared state between jobs, and no idle compute — each job gets a clean, isolated [microVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html). Two runner flavors are available: a plain runner and a Docker-in-Docker runner, selected per job by label.

It is implemented in TypeScript and deployed with [OpenTofu](https://opentofu.org/). Tooling (Node.js, Bun, OpenTofu) is pinned with [mise](https://mise.jdx.dev/), and JavaScript dependencies are managed with [Bun](https://bun.sh/).

## Architecture

The request flows in one direction — from a GitHub webhook through to a launched runner — and the runner then connects back to GitHub to pick up its job:

![High-level architecture: GitHub webhook → API Gateway → Lambda orchestrator → SQS → Lambda worker → Lambda MicroVM](docs/architecture.svg)

1. **[GitHub](https://docs.github.com/en/webhooks/about-webhooks)** sends a [`workflow_job`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_job) webhook (HMAC-SHA256 signed) when a job is queued.
2. **[Amazon API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)** (HTTP API) exposes the `POST /webhook` endpoint and invokes the orchestrator.
3. **[AWS Lambda](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) — Orchestrator** verifies the webhook signature, filters for queued `workflow_job` events carrying the required label, and enqueues a runner request. It responds fast so GitHub's webhook delivery never blocks on runner provisioning.
4. **[Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html)** decouples acceptance from provisioning and provides retries plus a dead-letter queue for failed requests.
5. **[AWS Lambda](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html) — Worker** consumes the queue, mints [JIT runner credentials](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-an-organization) from the GitHub App, and launches the runner.
6. **[AWS Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)** boots as an ephemeral, isolated runner, registers with GitHub as a JIT self-hosted runner, executes the single workflow job, and self-terminates.

## Prerequisites

- [mise](https://mise.jdx.dev/) — provisions the pinned toolchain (Node.js 22, Bun, OpenTofu 1.12). Run `mise install` in the repo root.
  - Without mise: Node.js 22+, [Bun](https://bun.sh/), and [OpenTofu](https://opentofu.org/docs/intro/install/) ≥ 1.6 installed manually.
- AWS credentials for the target (dev) account/region. State lives in the S3 backend bucket configured in `.env` (see below).

## Setup

### 1. Configure `.env`

Copy the example and fill it in. `.env` is gitignored and is read by both the OpenTofu wrapper (`scripts/tofu.ts`) and the image-build script.

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `TF_STATE_BUCKET` | S3 bucket for OpenTofu state (supplied to `tofu init` via `-backend-config`) |
| `TF_STATE_REGION` | Region of the state bucket (defaults to `eu-central-1`) |
| `RUNNER_GROUP_ID` | GitHub runner group id (required for Phase B) |
| `MICROVM_IMAGE_ARN_DOCKER` / `MICROVM_IMAGE_ARN_NO_DOCKER` | Written automatically by `bun run build:images` |

mise auto-loads `.env` into the environment; the AWS profile/region default to `default` / `eu-central-1` and can be overridden with the `aws_profile` / `aws_region` OpenTofu variables.

### 2. Install tooling and dependencies

```bash
mise install      # Node.js, Bun, OpenTofu at the versions pinned in mise.toml
bun install       # JavaScript dependencies
bun run init      # tofu init — configures the S3 backend from TF_STATE_BUCKET
```

### 3. Create the SSM SecureString parameters (required before deploy)

The HMAC shared secret and the GitHub App credentials are stored in SSM Parameter Store as SecureStrings. OpenTofu **references** them but does not create them (they hold secrets), so create them out-of-band:

```bash
aws ssm put-parameter \
  --name /github-runner-orchestrator/webhook-secret \
  --type SecureString \
  --value "<your-shared-hmac-secret>"
```

See [GitHub App credentials parameter](#github-app-credentials-parameter) below for the second parameter. To use custom names, set the `webhook_secret_param_name` / `app_credentials_param_name` OpenTofu variables.

### 4. Deploy to AWS (two phases)

Deployment is a two-phase apply, mirroring the previous CDK flow. `.env` (image ARNs) is generated automatically between the phases.

**Phase A — infrastructure (code bucket + build role)**

With the image ARNs unset, `bun run deploy` creates only the `microvm_code` bucket and the `microvm_build` role. The orchestrator Lambda and API Gateway are absent because the MicroVM image ARNs are not set yet.

```bash
bun run deploy    # bundles Lambdas (no-op for Phase A) + tofu apply
```

**Build the MicroVM images**

The runner ships in two flavors built from the same `microvm/` sources but different Dockerfiles:

| Flavor | Image name | Dockerfile | `.env` key |
|---|---|---|---|
| docker | `github-runner-docker` | `Dockerfile.docker` | `MICROVM_IMAGE_ARN_DOCKER` |
| no-docker | `github-runner-no-docker` | `Dockerfile.base` | `MICROVM_IMAGE_ARN_NO_DOCKER` |

```bash
bun run build:images          # builds docker, then no-docker, sequentially
# or a single flavor:
bun run build:image:docker
bun run build:image:no-docker
```

Each run reads the Phase A outputs via `tofu output -json`, zips `microvm/` (with the flavor's Dockerfile staged as `Dockerfile`) into `app.zip`, uploads it to the code bucket, creates/updates the flavor-specific MicroVM image, polls until the build completes, deletes superseded versions, and writes the matching `MICROVM_IMAGE_ARN_*` key to `.env`.

**Phase B — the orchestrator**

With both image ARNs now in `.env` and `RUNNER_GROUP_ID` set, apply again. This adds the orchestrator Lambda, the SQS queue + worker Lambda, and the API Gateway:

```bash
bun run deploy
```

After this apply, `tofu output` includes `webhook_url`, `webhook_secret_param_name`, `app_credentials_param_name`, `microvm_image_arn_docker` / `microvm_image_arn_no_docker`, and `queue_url` / `dlq_url`.

Clearing either ARN from `.env` on a later apply removes the Phase B resources — expected desired-state behavior. Both ARNs must be present for Phase B to be created.

### 5. Configure GitHub

1. In your GitHub repository or organization, go to **Settings → Webhooks → Add webhook**.
2. Set **Payload URL** to the `webhook_url` output value.
3. Set **Content type** to `application/json`.
4. Set **Secret** to the same value you stored in SSM.
5. Choose which events to send (or select **Send me everything**).

## Development

```bash
bun run build        # type-check (tsc --noEmit)
bun test             # jest unit tests
bun run build:lambdas  # bundle the Lambdas into dist/ with esbuild
bun run synth        # bundle Lambdas + tofu plan (dry run)
bun run tofu <args>  # any tofu subcommand, with .env vars wired in
```

mise tasks wrap the common flows too: `mise run install|build|test|init|synth|deploy|build-images`.

## Infrastructure layout (`tofu/`)

| File | Contents |
|---|---|
| `versions.tf` | Required versions, providers, and the partial S3 backend (bucket injected at `init`) |
| `variables.tf` | All input variables (param names, labels, timeouts, image ARNs, runner group id) |
| `main.tf` | Phase A: code bucket + build role, plus derived locals (base image / connector / SSM ARNs) |
| `lambda.tf` | Phase B: execution role, SQS queues, orchestrator + worker Lambdas, API Gateway |
| `outputs.tf` | Phase A + Phase B outputs (Phase B outputs are `null` until both image ARNs are set) |

**Two-phase gating.** `local.phase_b = var.microvm_image_arn_docker != "" && var.microvm_image_arn_no_docker != ""`. Every Phase B resource carries `count = local.phase_b ? 1 : 0`, so a single config expresses both phases — exactly what the CDK stack did with an `if` block.

**State.** Stored in the S3 backend with native lockfile-based locking (`use_lockfile = true`). The bucket and region are **not** hardcoded in the `.tf` files — they come from `TF_STATE_BUCKET` / `TF_STATE_REGION` in the gitignored `.env`, passed to `tofu init` as `-backend-config` by `scripts/tofu.ts`.

## Component reference

- **API Gateway v2 (HTTP API)**: Accepts `POST /webhook` from GitHub.
- **Lambda (Orchestrator)**: Loads the HMAC secret from SSM at cold start, verifies the `X-Hub-Signature-256` header, filters `workflow_job` events for `action == "queued"` and the `lambda-microvms` label, enqueues matching jobs to SQS, and returns `202`. Non-matching events return `200 ignored`. Invalid/missing signature returns `401`. SSM load failure returns `500`.
- **Lambda (Worker)**: Consumes the SQS queue, retrieves JIT runner credentials from GitHub, and launches a MicroVM runner. The runner image is selected per job by label: jobs carrying the docker label (default `docker`) launch the `github-runner-docker` image (Docker-in-Docker enabled); all other jobs launch the `github-runner-no-docker` image. See `src/microvms.ts` (`selectImageIdentifier`).
- **SSM SecureString (webhook secret)**: Holds the shared webhook secret. Referenced (not created) by the config.
- **SSM SecureString (app credentials)**: Holds the GitHub App credentials as a JSON object. Referenced (not created) by the config.

The Lambdas are bundled with esbuild (`scripts/build-lambdas.ts`) into `dist/<name>/index.js` — CommonJS, `node22`, `@aws-sdk/*` bundled in to pin versions — and zipped by the `archive_file` data source. This replaces CDK's `NodejsFunction`.

---

## Event filtering and JIT runner credential retrieval

### GitHub App credentials parameter

The worker reads GitHub App credentials from a second SSM SecureString at
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

### OpenTofu variables

Set via `TF_VAR_<name>` env vars, a `*.tfvars` file, or `-var` flags. `scripts/tofu.ts` maps a few `.env` keys automatically (see below).

| Variable | Default | Description |
|---|---|---|
| `aws_region` | `eu-central-1` | Region to deploy into |
| `aws_profile` | `default` | Named AWS profile (the dev account) |
| `webhook_secret_param_name` | `/github-runner-orchestrator/webhook-secret` | SSM path to the webhook HMAC secret |
| `app_credentials_param_name` | `/github-runner-orchestrator/app-credentials` | SSM path to the GitHub App credentials |
| `required_runner_label` | `lambda-microvms` | Label a job must carry to trigger a JIT runner |
| `docker_runner_label` | `docker` | Label that routes a job to the `github-runner-docker` image |
| `microvm_max_idle_seconds` / `microvm_suspended_seconds` / `microvm_max_duration_seconds` | `1800` / `10` / `3600` | MicroVM lifecycle timeouts |
| `microvm_image_arn_docker` / `microvm_image_arn_no_docker` | `""` | Built image ARNs; both gate Phase B |
| `runner_group_id` | `""` | GitHub runner group id (required for Phase B) |

`scripts/tofu.ts` bridges `.env` → variables: `MICROVM_IMAGE_ARN_DOCKER`, `MICROVM_IMAGE_ARN_NO_DOCKER`, and `RUNNER_GROUP_ID` become `TF_VAR_microvm_image_arn_docker`, `TF_VAR_microvm_image_arn_no_docker`, and `TF_VAR_runner_group_id`.

### Filtering behaviour

The handler processes only `workflow_job` webhooks where:
- `action == "queued"` **and**
- `workflow_job.labels` contains the required label (default: `lambda-microvms`).

All other events (wrong type, wrong action, missing label) are logged with a clear reason and
acknowledged with `200 ignored` — no runner work is performed.

---

## MicroVM image build and two-phase deploy

### MicroVM runtime source (`microvm/`)

The `microvm/` directory contains the source files zipped into `app.zip` and uploaded to S3 by `scripts/build-microvm-image.ts`:

| File | Description |
|---|---|
| `Dockerfile.base` | Ubuntu 24.04-based image with Node.js 22, the GitHub Actions runner, and a Python tool cache — the **no-docker** flavor |
| `Dockerfile.docker` | Builds on the base with a Docker-in-Docker daemon — the **docker** flavor |
| `app.js` | Lifecycle hook server — handles the `ready`, `run`, and `terminate` hooks on port 9000 |
| `entrypoint.sh` | Shell script that passes `ENCODED_JIT_CONFIG` to `run.sh --jitconfig` |
| `package.json` | Manifest declaring `@aws-sdk/client-lambda-microvms` as the sole runtime dependency |

Per build, the selected Dockerfile is staged into `app.zip` as `Dockerfile` alongside `app.js`, `entrypoint.sh`, and `package.json`. The zip is created and uploaded by `bun run build:images` (or a per-flavor `bun run build:image:*`) — not at `tofu plan`/`apply` time.

### MicroVM code S3 bucket

A dedicated `aws_s3_bucket` (`microvm_code`) holds `app.zip`. It has `prevent_destroy = true` (matching the CDK RETAIN removal policy), so it persists across applies. Its name is emitted as the `microvm_code_bucket_name` output.

### IAM roles

**`microvm_build`** (Phase A) — assumed by the image build service to pull `app.zip`:
- `s3:GetObject` / `s3:ListBucket` on the code bucket
- `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `arn:{partition}:logs:*:*:*`

**`microvm_execution`** (Phase B) — assumed by each MicroVM at runtime:
- `lambda:TerminateMicrovm` on both MicroVM image ARNs (so `app.js` can self-terminate)
- `logs:CreateLogGroup/CreateLogStream/PutLogEvents` on `*`

### MicroVM image build (`scripts/build-microvm-image.ts`)

The script takes a flavor argument (`docker` or `no-docker`) and drives image creation outside of OpenTofu:

1. Reads Phase A outputs via `tofu output -json` (code bucket name, build role ARN, base image ARN, region).
2. Stages the flavor's Dockerfile as `Dockerfile`, zips it with `app.js`, `entrypoint.sh`, `package.json` into `app.zip`, and uploads it to the code bucket.
3. Calls `CreateMicrovmImage` (or `UpdateMicrovmImage` if the image exists) with the image name, `minimumMemoryInMiB: 8192 (4 vCPUs)`, port-9000 lifecycle hooks (ready 180 s, run 30 s, terminate 30 s), and — for the docker flavor only — `additionalOsCapabilities: ["ALL"]`.
4. Polls until the image reaches `CREATED`/`UPDATED`.
5. Deletes superseded image versions, keeping only the one just built.
6. Writes the flavor's `MICROVM_IMAGE_ARN_*` key into `.env`.

The `.env` values are loaded by `dotenv` on the next `bun run deploy` (Phase B).

> **Why a script instead of a Terraform/OpenTofu resource?** There is no first-class resource for Lambda MicroVM images, and the ~minutes-long build needs a polling loop. A dedicated script (using the AWS SDK) gives full control and matches how the CDK version handled it.

### Base image and network connectors

Derived from region/partition in `main.tf`, no variables needed:

```
arn:{partition}:lambda:{region}:aws:microvm-image:al2023-1                          # base image
arn:{partition}:lambda:{region}:aws:network-connector:aws-network-connector:NO_INGRESS
arn:{partition}:lambda:{region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS
```

### Phase A outputs (always present)

Consumed by `scripts/build-microvm-image.ts`:

| Output | Description |
|---|---|
| `microvm_code_bucket_name` | Name of the S3 bucket holding `app.zip` |
| `microvm_build_role_arn` | ARN of the role passed to the image build |
| `microvm_base_image_arn` | ARN of the AWS-owned base image |
| `region` | AWS region deployed to |

---

> **SECURITY — credential logging:** Secrets are never written to logs. The webhook HMAC secret,
> the GitHub App private key, the installation token, and the JIT runner registration credential
> (`encoded_jit_config`) are all kept out of CloudWatch. Logs carry only non-sensitive metadata
> (run IDs, runner names, labels, image identifiers, timings). Error paths that touch the
> credential-bearing run-hook payload log the error *type* only — never the raw error message —
> so a parse failure cannot echo credential fragments.
