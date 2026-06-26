import { createHmac, timingSafeEqual } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { matchesRunnerRequest, parseWorkflowJobEvent } from './filter';
import type { WorkflowJobEvent } from './filter';
import {
  buildRunnerName,
  generateOrgJitConfig,
  getInstallationToken,
  mintAppJwt,
  parseAppCredentials
} from './github';
import { runMicrovm } from './microvms';
import type { MicrovmLaunchConfig } from './microvms';

const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM;
const APP_CREDENTIALS_PARAM = process.env.GITHUB_APP_CREDENTIALS_PARAM;
const RUNNER_GROUP_ID = Number(process.env.RUNNER_GROUP_ID ?? '1');
const REQUIRED_LABEL = process.env.REQUIRED_RUNNER_LABEL ?? 'lambda-microvms';
const ORG_OVERRIDE = process.env.GITHUB_ORG; // optional; otherwise derived from payload

function buildMicrovmConfig(): MicrovmLaunchConfig | string {
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
    suspendedDurationSeconds: Number(process.env.MICROVM_SUSPENDED_SECONDS ?? '1800'),
    maximumDurationInSeconds: Number(process.env.MICROVM_MAX_DURATION_SECONDS ?? '1800'),
  };
}

const microvmConfig = buildMicrovmConfig();

const ssm = new SSMClient({});

function loadParam(name: string | undefined, envLabel: string): Promise<string> {
  if (!name) return Promise.reject(new Error(`${envLabel} env var is not set`));
  return ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })).then((res) => {
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${name} has no value`);
    return value;
  });
}

let cachedSecret: Promise<string> | undefined;
let cachedCreds: Promise<string> | undefined;
const getWebhookSecret = (): Promise<string> =>
  (cachedSecret ??= loadParam(WEBHOOK_SECRET_PARAM, 'WEBHOOK_SECRET_PARAM'));
const getAppCredentials = (): Promise<string> =>
  (cachedCreds ??= loadParam(APP_CREDENTIALS_PARAM, 'GITHUB_APP_CREDENTIALS_PARAM'));

// Warm both during init; no-op catch avoids an init-time unhandledRejection (handler re-awaits).
getWebhookSecret().catch(() => undefined);
getAppCredentials().catch(() => undefined);

const reply = (statusCode: number, body: string): APIGatewayProxyResultV2 => ({ statusCode, body });

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  // 1. Verify HMAC signature (Phase 1 behaviour).
  let secret: string;
  try {
    secret = await getWebhookSecret();
  } catch (err) {
    console.error('Failed to load webhook secret:', err);
    return reply(500, 'secret unavailable');
  }

  const rawBody = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0);
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(event.headers?.['x-hub-signature-256'] ?? '');
  const expectedBuf = Buffer.from(expected);
  if (!(received.length === expectedBuf.length && timingSafeEqual(received, expectedBuf))) {
    console.warn('Rejected webhook: invalid or missing signature');
    return reply(401, 'invalid signature');
  }

  // 2. Only act on workflow_job events (ping and others are acknowledged + ignored).
  const eventType = event.headers?.['x-github-event'];
  if (eventType !== 'workflow_job') {
    console.log(`Ignoring event type '${eventType ?? '(none)'}' (not workflow_job)`);
    return reply(200, 'ignored');
  }

  // 3. Parse + filter. (Annotated type; the catch returns, so TS sees `parsed` as definitely assigned.)
  let parsed: WorkflowJobEvent;
  try {
    parsed = parseWorkflowJobEvent(rawBody.toString('utf8'));
  } catch (err) {
    console.error('Failed to parse webhook body as JSON:', err);
    return reply(400, 'invalid json');
  }
  const match = matchesRunnerRequest(parsed, REQUIRED_LABEL);
  if (!match.matched) {
    console.log(`Ignoring workflow_job event: ${match.reason}`);
    return reply(200, 'ignored');
  }
  console.log(`Matched runner request: ${match.reason}`);

  // 4. Resolve target org.
  const org = ORG_OVERRIDE ?? parsed.organization?.login;
  if (!org) {
    console.error('Cannot determine organization from payload (organization.login missing)');
    return reply(422, 'missing organization');
  }

  // 5. Retrieve JIT credentials via the GitHub App and launch a MicroVM.
  if (typeof microvmConfig === 'string') {
    console.error(microvmConfig);
    return reply(500, 'microvm not configured');
  }

  try {
    const creds = parseAppCredentials(await getAppCredentials());
    const jwt = mintAppJwt(creds.appClientId, creds.privateKey);
    const token = await getInstallationToken(jwt, creds.installationId);
    const jit = await generateOrgJitConfig(token, org, {
      name: buildRunnerName(parsed.workflow_job?.run_id),
      runnerGroupId: RUNNER_GROUP_ID,
      labels: parsed.workflow_job?.labels ?? [REQUIRED_LABEL]
    });

    console.log('JIT runner created:', JSON.stringify(jit.runner));

    const vm = await runMicrovm(microvmConfig, jit.encoded_jit_config);

    console.log('MicroVM launched:', vm.microvmId, 'endpoint:', vm.endpoint);
    return reply(202, 'microvm launched');
  } catch (err) {
    console.error('Failed to launch MicroVM:', err);
    return reply(500, 'microvm launch failed');
  }
};
