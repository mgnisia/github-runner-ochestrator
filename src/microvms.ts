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
