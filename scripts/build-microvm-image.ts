/**
 * build-microvm-image.ts
 *
 * Zips microvm/, uploads to S3, and creates or updates the `github-runner` MicroVM image,
 * then polls until CREATED/UPDATED and writes the ARN to .env.
 *
 * Run via: npm run build:image
 * Prerequisites: npm run deploy (produces output.json with stack outputs)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  CreateMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  GetMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';

// ── Constants ────────────────────────────────────────────────────────────────

const STACK_NAME = 'GithubRunnerOrchestratorStack';
const IMAGE_NAME = 'github-runner';
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Upserts MICROVM_IMAGE_ARN in a .env file's string contents.
 * - If the key already exists, replaces that line in-place.
 * - Otherwise appends the key to the end (with a leading newline if needed).
 * - Preserves all other lines exactly.
 */
export function upsertEnvArn(existingContents: string, arn: string): string {
  const line = `MICROVM_IMAGE_ARN=${arn}`;
  const keyPattern = /^MICROVM_IMAGE_ARN=.*$/m;
  if (keyPattern.test(existingContents)) {
    return existingContents.replace(keyPattern, line);
  }
  if (existingContents === '' || existingContents.endsWith('\n')) {
    return existingContents + line + '\n';
  }
  return existingContents + '\n' + line + '\n';
}

/**
 * Finds a MicroVM image item whose name matches targetName EXACTLY.
 * nameFilter used in ListMicrovmImages is a substring filter, so an exact check is required
 * here to avoid false matches (e.g. 'github-runner-2' matching a filter of 'github-runner').
 */
export function findExactImage(
  items: { name?: string; imageArn?: string }[],
  targetName: string
): { name?: string; imageArn?: string } | undefined {
  return items.find((item) => item.name === targetName);
}

// ── Main script ──────────────────────────────────────────────────────────────

async function readOutputs(): Promise<{
  MicrovmCodeBucketName: string;
  MicrovmBuildRoleArn: string;
  MicrovmBaseImageArn: string;
  Region: string;
}> {
  const outputPath = path.join(__dirname, '..', 'output.json');
  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `output.json not found at ${outputPath}. Please run \`npm run deploy\` first to generate stack outputs.`
    );
  }

  let raw: Record<string, Record<string, string>>;
  try {
    raw = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch {
    throw new Error(
      `Failed to parse output.json. Please run \`npm run deploy\` first to regenerate stack outputs.`
    );
  }

  const stackOutputs = raw[STACK_NAME];
  if (!stackOutputs) {
    throw new Error(
      `output.json does not contain key "${STACK_NAME}". Please run \`npm run deploy\` first.`
    );
  }

  const required = ['MicrovmCodeBucketName', 'MicrovmBuildRoleArn', 'MicrovmBaseImageArn', 'Region'] as const;
  for (const key of required) {
    if (!stackOutputs[key]) {
      throw new Error(
        `Missing output "${key}" under "${STACK_NAME}" in output.json. Please run \`npm run deploy\` first.`
      );
    }
  }

  return {
    MicrovmCodeBucketName: stackOutputs['MicrovmCodeBucketName'],
    MicrovmBuildRoleArn: stackOutputs['MicrovmBuildRoleArn'],
    MicrovmBaseImageArn: stackOutputs['MicrovmBaseImageArn'],
    Region: stackOutputs['Region'],
  };
}

function zipMicrovm(): string {
  const microvmDir = path.join(__dirname, '..', 'microvm');
  const tmpZipPath = path.join(os.tmpdir(), 'app.zip');

  console.log(`Zipping microvm/ into ${tmpZipPath} ...`);

  // Explicit file list mirrors the proven deploy.sh approach: prevents .DS_Store and
  // self-referential app.zip leaks (same list as the old lib/orchestrator-stack.ts bundler).
  const result = spawnSync(
    'zip',
    ['-r', tmpZipPath, 'Dockerfile', 'app.js', 'entrypoint.sh', 'package.json'],
    { cwd: microvmDir, stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error(`zip exited with status ${result.status ?? '(unknown)'}`);
  }

  console.log('Zip complete.');
  return tmpZipPath;
}

async function uploadToS3(bucketName: string, region: string, zipPath: string): Promise<void> {
  console.log(`Uploading app.zip to s3://${bucketName}/app.zip ...`);
  const client = new S3Client({ region });
  const body = fs.readFileSync(zipPath);
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: 'app.zip',
      Body: body,
    })
  );
  console.log('Upload complete.');
}

async function findExistingImage(
  microvmsClient: LambdaMicrovmsClient
): Promise<{ name?: string; imageArn?: string } | undefined> {
  console.log(`Checking for existing MicroVM image "${IMAGE_NAME}" ...`);

  const allItems: { name?: string; imageArn?: string }[] = [];
  let nextToken: string | undefined;

  do {
    const response = await microvmsClient.send(
      new ListMicrovmImagesCommand({ nameFilter: IMAGE_NAME, nextToken })
    );
    allItems.push(...(response.items ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return findExactImage(allItems, IMAGE_NAME);
}

async function createOrUpdate(
  microvmsClient: LambdaMicrovmsClient,
  existing: { name?: string; imageArn?: string } | undefined,
  params: {
    codeArtifactUri: string;
    baseImageArn: string;
    buildRoleArn: string;
  }
): Promise<string> {
  const sharedInput = {
    codeArtifact: { uri: params.codeArtifactUri },
    baseImageArn: params.baseImageArn,
    buildRoleArn: params.buildRoleArn,
    hooks: {
      port: 9000,
      microvmImageHooks: {
        ready: 'ENABLED' as const,
        readyTimeoutInSeconds: 60,
      },
      microvmHooks: {
        run: 'ENABLED' as const,
        runTimeoutInSeconds: 30,
        terminate: 'ENABLED' as const,
        terminateTimeoutInSeconds: 30,
      },
    },
  };

  if (!existing) {
    console.log(`Creating new MicroVM image "${IMAGE_NAME}" ...`);
    const response = await microvmsClient.send(
      new CreateMicrovmImageCommand({ name: IMAGE_NAME, ...sharedInput })
    );
    if (!response.imageArn) {
      throw new Error('CreateMicrovmImageCommand returned no imageArn');
    }
    console.log(`Create initiated. imageArn: ${response.imageArn}`);
    return response.imageArn;
  } else {
    console.log(`Updating existing MicroVM image "${IMAGE_NAME}" (${existing.imageArn}) ...`);
    const response = await microvmsClient.send(
      new UpdateMicrovmImageCommand({ imageIdentifier: existing.imageArn!, ...sharedInput })
    );
    if (!response.imageArn) {
      throw new Error('UpdateMicrovmImageCommand returned no imageArn');
    }
    console.log(`Update initiated. imageArn: ${response.imageArn}`);
    return response.imageArn;
  }
}

async function pollUntilReady(microvmsClient: LambdaMicrovmsClient, imageArn: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const terminalSuccess = new Set(['CREATED', 'UPDATED']);
  const terminalFailure = new Set(['CREATE_FAILED', 'UPDATE_FAILED']);

  console.log('Polling for image state ...');

  while (Date.now() < deadline) {
    const response = await microvmsClient.send(
      new GetMicrovmImageCommand({ imageIdentifier: imageArn })
    );
    const state = response.state ?? '(unknown)';
    console.log(`  Image state: ${state}`);

    if (terminalSuccess.has(state)) {
      return;
    }
    if (terminalFailure.has(state)) {
      throw new Error(`MicroVM image build failed with state: ${state}`);
    }

    // Still in progress (CREATING, UPDATING, etc.) — keep polling
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out after ${POLL_TIMEOUT_MS / 60_000} minutes waiting for MicroVM image to reach CREATED/UPDATED. Last checked imageArn: ${imageArn}`
  );
}

function writeEnvFile(imageArn: string): void {
  const envPath = path.join(__dirname, '..', '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const updated = upsertEnvArn(existing, imageArn);
  fs.writeFileSync(envPath, updated, 'utf8');
  console.log(`\nMICROVM_IMAGE_ARN=${imageArn}`);
  console.log('Image ready. Now run `npm run deploy` to deploy the orchestrator.');
}

async function main(): Promise<void> {
  console.log('=== build-microvm-image ===');

  // Step 1: read CDK outputs
  console.log('Reading CDK outputs from output.json ...');
  const { MicrovmCodeBucketName, MicrovmBuildRoleArn, MicrovmBaseImageArn, Region } =
    await readOutputs();
  console.log(`  Region:              ${Region}`);
  console.log(`  CodeBucket:          ${MicrovmCodeBucketName}`);
  console.log(`  BuildRoleArn:        ${MicrovmBuildRoleArn}`);
  console.log(`  BaseImageArn:        ${MicrovmBaseImageArn}`);

  // Step 2: zip microvm/
  const zipPath = zipMicrovm();

  // Step 3: upload to S3
  await uploadToS3(MicrovmCodeBucketName, Region, zipPath);

  // Step 4-6: detect, create/update, poll
  const microvmsClient = new LambdaMicrovmsClient({ region: Region });

  const existing = await findExistingImage(microvmsClient);
  if (existing) {
    console.log(`Found existing image: ${existing.imageArn}`);
  } else {
    console.log('No existing image found — will create.');
  }

  const imageArn = await createOrUpdate(microvmsClient, existing, {
    codeArtifactUri: `s3://${MicrovmCodeBucketName}/app.zip`,
    baseImageArn: MicrovmBaseImageArn,
    buildRoleArn: MicrovmBuildRoleArn,
  });

  await pollUntilReady(microvmsClient, imageArn);

  // Step 7: write .env
  writeEnvFile(imageArn);
}

// Guard: only run main when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
