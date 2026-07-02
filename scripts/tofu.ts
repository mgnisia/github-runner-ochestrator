/**
 * tofu.ts
 *
 * Thin wrapper around `tofu -chdir=tofu <args>` that bridges the repo's `.env`
 * conventions to OpenTofu input variables. It loads `.env` and maps:
 *
 *   MICROVM_IMAGE_ARN_DOCKER     -> TF_VAR_microvm_image_arn_docker
 *   MICROVM_IMAGE_ARN_NO_DOCKER  -> TF_VAR_microvm_image_arn_no_docker
 *   RUNNER_GROUP_ID              -> TF_VAR_runner_group_id
 *
 * so the two-phase deploy works without hand-passing -var flags:
 *   Phase A (image ARNs unset) -> creates code bucket + build role
 *   Phase B (both ARNs set)    -> creates Lambdas + SQS + API Gateway
 *
 * For `init`, it also supplies the S3 backend's bucket + region from .env
 * (TF_STATE_BUCKET / TF_STATE_REGION) via -backend-config, so the state bucket
 * is never hardcoded in committed .tf files.
 *
 * Usage: ts-node scripts/tofu.ts <init|plan|apply|output|destroy|...>
 */

import 'dotenv/config';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOFU_DIR = path.join(__dirname, '..', 'tofu');

const VAR_MAP: Record<string, string> = {
  MICROVM_IMAGE_ARN_DOCKER: 'TF_VAR_microvm_image_arn_docker',
  MICROVM_IMAGE_ARN_NO_DOCKER: 'TF_VAR_microvm_image_arn_no_docker',
  RUNNER_GROUP_ID: 'TF_VAR_runner_group_id',
};

const env = { ...process.env };
for (const [source, tfVar] of Object.entries(VAR_MAP)) {
  if (process.env[source]) {
    env[tfVar] = process.env[source];
  }
}

const args = process.argv.slice(2);

// On `init`, feed the S3 backend's bucket + region from .env so they are never
// committed to the .tf files. Missing bucket is a hard error — state must not
// silently fall back to local.
if (args[0] === 'init') {
  const bucket = process.env.TF_STATE_BUCKET;
  if (!bucket) {
    console.error(
      'TF_STATE_BUCKET is not set. Add it to your gitignored .env, e.g.\n' +
        '  TF_STATE_BUCKET=842187392333-dev-club-coaster-eu-central-1'
    );
    process.exit(1);
  }
  const region = process.env.TF_STATE_REGION ?? process.env.AWS_REGION ?? 'eu-central-1';
  args.push(`-backend-config=bucket=${bucket}`, `-backend-config=region=${region}`);
}

const result = spawnSync('tofu', [`-chdir=${TOFU_DIR}`, ...args], {
  stdio: 'inherit',
  env,
});

if (result.error) {
  console.error(
    `Failed to run tofu: ${result.error.message}. Is OpenTofu installed and on PATH?`
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
