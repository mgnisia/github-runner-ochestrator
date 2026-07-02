/**
 * build-microvm-image.ts
 *
 * Zips microvm/ for a given flavor, uploads to S3, creates or updates the
 * flavor-specific MicroVM image, polls until CREATED/UPDATED, deletes old
 * image versions, and writes the ARN to .env.
 *
 * Run via:
 *   bun run build:image:docker      (github-runner-docker)
 *   bun run build:image:no-docker   (github-runner-no-docker)
 *   bun run build:images            (both, sequentially)
 *
 * Prerequisites: `bun run deploy` (Phase A `tofu apply` creating the code
 * bucket + build role, whose values are read here via `tofu output -json`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  LambdaMicrovmsClient,
  ListMicrovmImagesCommand,
  ListMicrovmImageVersionsCommand,
  DeleteMicrovmImageVersionCommand,
  CreateMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageCommandOutput,
  Capability,
} from '@aws-sdk/client-lambda-microvms';

// ── Constants ────────────────────────────────────────────────────────────────

const TOFU_DIR = path.join(__dirname, '..', 'tofu');
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes

// ── Flavor configuration ─────────────────────────────────────────────────────

type Flavor = 'docker' | 'no-docker';

interface FlavorConfig {
  imageName: string;
  dockerfile: string;
  envKey: string;
  capabilities: Capability[] | undefined;
}

const FLAVORS: Record<Flavor, FlavorConfig> = {
  docker: {
    imageName: 'github-runner-docker',
    dockerfile: 'Dockerfile.docker',
    envKey: 'MICROVM_IMAGE_ARN_DOCKER',
    // Grant elevated Linux capabilities inside the MicroVM (the only supported value is ["ALL"]).
    // Required for the Docker-in-Docker daemon started in entrypoint.sh, which needs to mount
    // filesystems and create network namespaces. Capabilities apply within the VM isolation
    // boundary only. See https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
    capabilities: [Capability.ALL],
  },
  'no-docker': {
    imageName: 'github-runner-no-docker',
    dockerfile: 'Dockerfile.base',
    envKey: 'MICROVM_IMAGE_ARN_NO_DOCKER',
    // No elevated capabilities needed for the base (non-Docker) runner.
    capabilities: undefined,
  },
};

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/**
 * Upserts an env key/value pair in a .env file's string contents.
 * - If the key already exists, replaces that line in-place.
 * - Otherwise appends the key to the end (with a leading newline if needed).
 * - Preserves all other lines exactly.
 */
export function upsertEnvArn(existingContents: string, key: string, arn: string): string {
  const line = `${key}=${arn}`;
  const keyPattern = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
  if (keyPattern.test(existingContents)) {
    return existingContents.replace(keyPattern, line);
  }
  if (existingContents === '' || existingContents.endsWith('\n')) {
    return existingContents + line + '\n';
  }
  return existingContents + '\n' + line + '\n';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * Returns the imageVersion strings that should be deleted, given a set of
 * version summaries and the version to keep.
 * - Items whose imageVersion is undefined are silently skipped.
 * - If keepVersion is falsy, returns [] (delete nothing).
 */
export function selectVersionsToDelete(
  versions: { imageVersion?: string }[],
  keepVersion: string
): string[] {
  if (!keepVersion) {
    return [];
  }
  return versions
    .filter((v): v is { imageVersion: string } => v.imageVersion !== undefined)
    .map((v) => v.imageVersion)
    .filter((v) => v !== keepVersion);
}

// ── Main script ──────────────────────────────────────────────────────────────

async function readOutputs(): Promise<{
  MicrovmCodeBucketName: string;
  MicrovmBuildRoleArn: string;
  MicrovmBaseImageArn: string;
  Region: string;
}> {
  // Read OpenTofu state outputs directly. `tofu output -json` emits
  // { "<name>": { "value": <v>, "sensitive": bool, "type": ... }, ... }.
  const result = spawnSync('tofu', ['output', '-json'], {
    cwd: TOFU_DIR,
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(
      `Failed to run \`tofu output -json\` in ${TOFU_DIR}: ${result.error.message}. Is OpenTofu installed and initialized?`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `\`tofu output -json\` exited with status ${result.status}. Have you run \`bun run deploy\` (Phase A apply) yet?\n${result.stderr ?? ''}`
    );
  }

  let raw: Record<string, { value: unknown }>;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new Error('Failed to parse `tofu output -json` stdout as JSON.');
  }

  const outputKeys = {
    MicrovmCodeBucketName: 'microvm_code_bucket_name',
    MicrovmBuildRoleArn: 'microvm_build_role_arn',
    MicrovmBaseImageArn: 'microvm_base_image_arn',
    Region: 'region',
  } as const;

  const values: Record<keyof typeof outputKeys, string> = {} as never;
  for (const [alias, tfName] of Object.entries(outputKeys) as [
    keyof typeof outputKeys,
    string
  ][]) {
    const value = raw[tfName]?.value;
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `Missing OpenTofu output "${tfName}". Please run \`bun run deploy\` first to apply Phase A.`
      );
    }
    values[alias] = value;
  }

  return values;
}

function zipMicrovm(dockerfile: string): string {
  const microvmDir = path.join(__dirname, '..', 'microvm');
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'microvm-stage-'));
  const tmpZipPath = path.join(os.tmpdir(), 'app.zip');

  console.log(`Staging microvm/ with ${dockerfile} into ${stagingDir} ...`);

  // Copy explicit allow-list of files into the staging dir, renaming the
  // chosen Dockerfile to 'Dockerfile'. This prevents .DS_Store / app.zip
  // leaks and supports per-flavor Dockerfile selection without relying on
  // zip's inability to rename entries.
  const filesToCopy: Array<[string, string]> = [
    [path.join(microvmDir, dockerfile), path.join(stagingDir, 'Dockerfile')],
    [path.join(microvmDir, 'app.js'), path.join(stagingDir, 'app.js')],
    [path.join(microvmDir, 'entrypoint.sh'), path.join(stagingDir, 'entrypoint.sh')],
    [path.join(microvmDir, 'package.json'), path.join(stagingDir, 'package.json')],
  ];
  for (const [src, dst] of filesToCopy) {
    fs.copyFileSync(src, dst);
  }

  console.log(`Zipping staged files into ${tmpZipPath} ...`);

  const result = spawnSync(
    'zip',
    ['-r', tmpZipPath, 'Dockerfile', 'app.js', 'entrypoint.sh', 'package.json'],
    { cwd: stagingDir, stdio: 'inherit' }
  );

  // Clean up staging dir regardless of zip outcome
  fs.rmSync(stagingDir, { recursive: true, force: true });

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
  microvmsClient: LambdaMicrovmsClient,
  imageName: string
): Promise<{ name?: string; imageArn?: string } | undefined> {
  console.log(`Checking for existing MicroVM image "${imageName}" ...`);

  const allItems: { name?: string; imageArn?: string }[] = [];
  let nextToken: string | undefined;

  do {
    const response = await microvmsClient.send(
      new ListMicrovmImagesCommand({ nameFilter: imageName, nextToken })
    );
    allItems.push(...(response.items ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  return findExactImage(allItems, imageName);
}

async function createOrUpdate(
  microvmsClient: LambdaMicrovmsClient,
  flavor: FlavorConfig,
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
    // Only include additionalOsCapabilities when the flavor requires them.
    // The no-docker flavor omits this field entirely.
    ...(flavor.capabilities !== undefined
      ? { additionalOsCapabilities: flavor.capabilities }
      : {}),
    resources: [{
      minimumMemoryInMiB: 4096,
    }],
    hooks: {
      port: 9000,
      microvmImageHooks: {
        ready: 'ENABLED' as const,
        // Build-time only (not job runtime); sized to cover dockerd becoming ready
        // (≤50s) plus the SAM base image pull warmed into the snapshot (≤120s), with
        // headroom to spare. See microvm/app.js for DOCKER_READY_DEADLINE_MS and
        // PREWARM_DEADLINE_MS constants that must fit within this budget.
        readyTimeoutInSeconds: 180,
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
    console.log(`Creating new MicroVM image "${flavor.imageName}" ...`);
    const response = await microvmsClient.send(
      new CreateMicrovmImageCommand({ name: flavor.imageName, ...sharedInput })
    );
    if (!response.imageArn) {
      throw new Error('CreateMicrovmImageCommand returned no imageArn');
    }
    console.log(`Create initiated. imageArn: ${response.imageArn}`);
    return response.imageArn;
  } else {
    console.log(`Updating existing MicroVM image "${flavor.imageName}" (${existing.imageArn}) ...`);
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

async function pollUntilReady(
  microvmsClient: LambdaMicrovmsClient,
  imageArn: string
): Promise<GetMicrovmImageCommandOutput> {
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
      return response;
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

async function deleteOldImageVersions(
  microvmsClient: LambdaMicrovmsClient,
  imageIdentifier: string,
  keepVersion: string
): Promise<void> {
  if (!keepVersion) {
    console.log('Warning: latestActiveImageVersion is missing — skipping old-version cleanup.');
    return;
  }

  const allVersions: { imageVersion?: string }[] = [];
  let nextToken: string | undefined;

  do {
    const response = await microvmsClient.send(
      new ListMicrovmImageVersionsCommand({ imageIdentifier, nextToken })
    );
    allVersions.push(...(response.items ?? []));
    nextToken = response.nextToken;
  } while (nextToken);

  const toDelete = selectVersionsToDelete(allVersions, keepVersion);

  for (const imageVersion of toDelete) {
    console.log(`  Deleting old image version: ${imageVersion}`);
    await microvmsClient.send(
      new DeleteMicrovmImageVersionCommand({ imageIdentifier, imageVersion })
    );
  }

  console.log(`Deleted ${toDelete.length} old image version(s).`);
}

function writeEnvFile(envKey: string, imageArn: string): void {
  const envPath = path.join(__dirname, '..', '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const updated = upsertEnvArn(existing, envKey, imageArn);
  fs.writeFileSync(envPath, updated, 'utf8');
  console.log(`\n${envKey}=${imageArn}`);
  console.log('Image ready. Now run `bun run deploy` to deploy the orchestrator.');
}

async function main(): Promise<void> {
  // Validate flavor argument
  const flavorArg = process.argv[2];
  const validFlavors = Object.keys(FLAVORS).join(', ');
  if (!flavorArg || !(flavorArg in FLAVORS)) {
    console.error(`Error: missing or invalid flavor argument: ${JSON.stringify(flavorArg ?? '')}`);
    console.error(`Usage: ts-node scripts/build-microvm-image.ts <flavor>`);
    console.error(`Valid flavors: ${validFlavors}`);
    process.exit(1);
  }
  const flavor = FLAVORS[flavorArg as Flavor];

  console.log(`=== build-microvm-image [${flavorArg}] ===`);

  // Step 1: read OpenTofu outputs
  console.log('Reading OpenTofu outputs via `tofu output -json` ...');
  const { MicrovmCodeBucketName, MicrovmBuildRoleArn, MicrovmBaseImageArn, Region } =
    await readOutputs();
  console.log(`  Region:              ${Region}`);
  console.log(`  CodeBucket:          ${MicrovmCodeBucketName}`);
  console.log(`  BuildRoleArn:        ${MicrovmBuildRoleArn}`);
  console.log(`  BaseImageArn:        ${MicrovmBaseImageArn}`);

  // Step 2: zip microvm/ using the flavor's Dockerfile
  const zipPath = zipMicrovm(flavor.dockerfile);

  // Step 3: upload to S3
  await uploadToS3(MicrovmCodeBucketName, Region, zipPath);

  // Step 4-6: detect, create/update, poll
  const microvmsClient = new LambdaMicrovmsClient({ region: Region });

  const existing = await findExistingImage(microvmsClient, flavor.imageName);
  if (existing) {
    console.log(`Found existing image: ${existing.imageArn}`);
  } else {
    console.log('No existing image found — will create.');
  }

  const imageArn = await createOrUpdate(microvmsClient, flavor, existing, {
    codeArtifactUri: `s3://${MicrovmCodeBucketName}/app.zip`,
    baseImageArn: MicrovmBaseImageArn,
    buildRoleArn: MicrovmBuildRoleArn,
  });

  const pollResult = await pollUntilReady(microvmsClient, imageArn);

  // Step 7: delete old image versions, keeping only the one just built
  const latestActiveImageVersion = pollResult.latestActiveImageVersion ?? '';
  await deleteOldImageVersions(microvmsClient, imageArn, latestActiveImageVersion);

  // Step 8: write .env
  writeEnvFile(flavor.envKey, imageArn);
}

// Guard: only run main when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
