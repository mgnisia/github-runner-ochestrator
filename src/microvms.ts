import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { LambdaMicrovmsClient, RunMicrovmCommand } from '@aws-sdk/client-lambda-microvms';

const client = new LambdaMicrovmsClient({});
const gzipAsync = promisify(gzip);

export interface MicrovmLaunchConfig {
  imageIdentifier: string;
  executionRoleArn: string;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  maximumDurationInSeconds: number;
}

export interface MicrovmConfig {
  base: Omit<MicrovmLaunchConfig, 'imageIdentifier'>;
  images: { docker: string; noDocker: string };
  dockerLabel: string;
}

export interface RunMicrovmResult {
  microvmId: string;
  endpoint: string;
}

/**
 * Select the correct MicroVM image identifier based on the job's labels.
 * Defaults to the no-docker image; opt-in by including the docker label.
 */
export function selectImageIdentifier(
  labels: string[],
  images: { docker: string; noDocker: string },
  dockerLabel: string,
): string {
  return labels.includes(dockerLabel) ? images.docker : images.noDocker;
}

/** Build a MicrovmConfig from environment variables. Returns an error string if misconfigured. */
export function buildMicrovmConfig(): MicrovmConfig | string {
  const dockerImageIdentifier = process.env.MICROVM_IMAGE_IDENTIFIER_DOCKER;
  const noDockerImageIdentifier = process.env.MICROVM_IMAGE_IDENTIFIER_NO_DOCKER;
  const executionRoleArn = process.env.MICROVM_EXECUTION_ROLE_ARN;
  const ingressRaw = process.env.MICROVM_INGRESS_NETWORK_CONNECTORS;
  const egressRaw = process.env.MICROVM_EGRESS_NETWORK_CONNECTORS;
  if (!dockerImageIdentifier) return 'MICROVM_IMAGE_IDENTIFIER_DOCKER env var is not set';
  if (!noDockerImageIdentifier) return 'MICROVM_IMAGE_IDENTIFIER_NO_DOCKER env var is not set';
  if (!executionRoleArn) return 'MICROVM_EXECUTION_ROLE_ARN env var is not set';
  if (!ingressRaw) return 'MICROVM_INGRESS_NETWORK_CONNECTORS env var is not set';
  if (!egressRaw) return 'MICROVM_EGRESS_NETWORK_CONNECTORS env var is not set';
  return {
    base: {
      executionRoleArn,
      ingressNetworkConnectors: ingressRaw.split(',').map((s) => s.trim()),
      egressNetworkConnectors: egressRaw.split(',').map((s) => s.trim()),
      maxIdleDurationSeconds: Number(process.env.MICROVM_MAX_IDLE_SECONDS ?? '900'),
      suspendedDurationSeconds: Number(process.env.MICROVM_SUSPENDED_SECONDS ?? '3600'),
      maximumDurationInSeconds: Number(process.env.MICROVM_MAX_DURATION_SECONDS ?? '3600'),
    },
    images: { docker: dockerImageIdentifier, noDocker: noDockerImageIdentifier },
    dockerLabel: process.env.DOCKER_RUNNER_LABEL ?? 'docker',
  };
}

async function compressJitConfig(jitConfig: string): Promise<string> {
  const compressed = await gzipAsync(Buffer.from(jitConfig, 'utf8'));
  return compressed.toString('base64');
}

export async function runMicrovm(
  config: MicrovmLaunchConfig,
  jitConfig: string
): Promise<RunMicrovmResult> {
  const runHookPayload = await compressJitConfig(jitConfig);

  const res = await client.send(
    new RunMicrovmCommand({
      imageIdentifier: config.imageIdentifier,
      executionRoleArn: config.executionRoleArn,
      ingressNetworkConnectors: config.ingressNetworkConnectors,
      egressNetworkConnectors: config.egressNetworkConnectors,
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: config.maxIdleDurationSeconds,
        suspendedDurationSeconds: config.suspendedDurationSeconds,
      },
      maximumDurationInSeconds: config.maximumDurationInSeconds,
      runHookPayload,
    })
  );

  if (!res.microvmId || !res.endpoint) {
    throw new Error('RunMicrovmCommand returned incomplete response');
  }

  return { microvmId: res.microvmId, endpoint: res.endpoint };
}

/** Launch a MicroVM with up to `opts.attempts` attempts, sleeping `opts.delayMs` between failures. */
export async function runMicrovmWithRetry(
  config: MicrovmLaunchConfig,
  jitConfig: string,
  opts: { attempts: number; delayMs: number }
): Promise<RunMicrovmResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const t = Date.now();
    try {
      const result = await runMicrovm(config, jitConfig);
      console.log(`runMicrovm attempt ${attempt}/${opts.attempts}: success in ${Date.now() - t}ms`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`runMicrovm attempt ${attempt}/${opts.attempts}: failed after ${Date.now() - t}ms`, err);
      if (attempt < opts.attempts) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
    }
  }
  throw lastErr;
}
