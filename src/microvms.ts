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

export interface RunMicrovmResult {
  microvmId: string;
  endpoint: string;
}

/** Build a MicrovmLaunchConfig from environment variables. Returns an error string if misconfigured. */
export function buildMicrovmConfig(): MicrovmLaunchConfig | string {
  const imageIdentifier = process.env.MICROVM_IMAGE_IDENTIFIER;
  const executionRoleArn = process.env.MICROVM_EXECUTION_ROLE_ARN;
  const ingressRaw = process.env.MICROVM_INGRESS_NETWORK_CONNECTORS;
  const egressRaw = process.env.MICROVM_EGRESS_NETWORK_CONNECTORS;
  if (!imageIdentifier) return 'MICROVM_IMAGE_IDENTIFIER env var is not set';
  if (!executionRoleArn) return 'MICROVM_EXECUTION_ROLE_ARN env var is not set';
  if (!ingressRaw) return 'MICROVM_INGRESS_NETWORK_CONNECTORS env var is not set';
  if (!egressRaw) return 'MICROVM_EGRESS_NETWORK_CONNECTORS env var is not set';
  return {
    imageIdentifier,
    executionRoleArn,
    ingressNetworkConnectors: ingressRaw.split(',').map((s) => s.trim()),
    egressNetworkConnectors: egressRaw.split(',').map((s) => s.trim()),
    maxIdleDurationSeconds: Number(process.env.MICROVM_MAX_IDLE_SECONDS ?? '900'),
    suspendedDurationSeconds: Number(process.env.MICROVM_SUSPENDED_SECONDS ?? '3600'),
    maximumDurationInSeconds: Number(process.env.MICROVM_MAX_DURATION_SECONDS ?? '3600'),
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
