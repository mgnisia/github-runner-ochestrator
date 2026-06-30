import { selectImageIdentifier, buildMicrovmConfig } from '../src/microvms';

const DOCKER_ARN = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner-docker';
const NO_DOCKER_ARN = 'arn:aws:lambda:eu-west-1:123456789012:microvm-image:github-runner-no-docker';
const IMAGES = { docker: DOCKER_ARN, noDocker: NO_DOCKER_ARN };

describe('selectImageIdentifier', () => {
  test('returns docker image when docker label is present', () => {
    expect(selectImageIdentifier(['lambda-microvms', 'docker'], IMAGES, 'docker')).toBe(DOCKER_ARN);
  });

  test('returns no-docker image when docker label is absent', () => {
    expect(selectImageIdentifier(['lambda-microvms'], IMAGES, 'docker')).toBe(NO_DOCKER_ARN);
  });

  test('returns no-docker image for empty labels', () => {
    expect(selectImageIdentifier([], IMAGES, 'docker')).toBe(NO_DOCKER_ARN);
  });

  test('respects a custom dockerLabel', () => {
    expect(selectImageIdentifier(['lambda-microvms', 'gpu-docker'], IMAGES, 'gpu-docker')).toBe(DOCKER_ARN);
    expect(selectImageIdentifier(['lambda-microvms', 'docker'], IMAGES, 'gpu-docker')).toBe(NO_DOCKER_ARN);
  });
});

describe('buildMicrovmConfig', () => {
  const BASE_ENV: Record<string, string> = {
    MICROVM_IMAGE_IDENTIFIER_DOCKER: DOCKER_ARN,
    MICROVM_IMAGE_IDENTIFIER_NO_DOCKER: NO_DOCKER_ARN,
    MICROVM_EXECUTION_ROLE_ARN: 'arn:aws:iam::123456789012:role/MicrovmExecRole',
    MICROVM_INGRESS_NETWORK_CONNECTORS: 'arn:ingress',
    MICROVM_EGRESS_NETWORK_CONNECTORS: 'arn:egress',
  };

  beforeEach(() => {
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
    delete process.env.DOCKER_RUNNER_LABEL;
    delete process.env.MICROVM_MAX_IDLE_SECONDS;
    delete process.env.MICROVM_SUSPENDED_SECONDS;
    delete process.env.MICROVM_MAX_DURATION_SECONDS;
  });

  afterEach(() => {
    for (const k of Object.keys(BASE_ENV)) delete process.env[k];
    delete process.env.DOCKER_RUNNER_LABEL;
  });

  test('returns a valid MicrovmConfig with defaults when all required env vars are set', () => {
    const result = buildMicrovmConfig();
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;

    expect(result.images.docker).toBe(DOCKER_ARN);
    expect(result.images.noDocker).toBe(NO_DOCKER_ARN);
    expect(result.dockerLabel).toBe('docker');
    expect(result.base.executionRoleArn).toBe('arn:aws:iam::123456789012:role/MicrovmExecRole');
    expect(result.base.ingressNetworkConnectors).toEqual(['arn:ingress']);
    expect(result.base.egressNetworkConnectors).toEqual(['arn:egress']);
    expect(result.base.maxIdleDurationSeconds).toBe(1800);
    expect(result.base.suspendedDurationSeconds).toBe(10);
    expect(result.base.maximumDurationInSeconds).toBe(3600);
  });

  test('reads DOCKER_RUNNER_LABEL from env when set', () => {
    process.env.DOCKER_RUNNER_LABEL = 'custom-docker';
    const result = buildMicrovmConfig();
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;
    expect(result.dockerLabel).toBe('custom-docker');
  });

  test('returns error string when MICROVM_IMAGE_IDENTIFIER_DOCKER is missing', () => {
    delete process.env.MICROVM_IMAGE_IDENTIFIER_DOCKER;
    expect(buildMicrovmConfig()).toBe('MICROVM_IMAGE_IDENTIFIER_DOCKER env var is not set');
  });

  test('returns error string when MICROVM_IMAGE_IDENTIFIER_NO_DOCKER is missing', () => {
    delete process.env.MICROVM_IMAGE_IDENTIFIER_NO_DOCKER;
    expect(buildMicrovmConfig()).toBe('MICROVM_IMAGE_IDENTIFIER_NO_DOCKER env var is not set');
  });

  test('returns error string when MICROVM_EXECUTION_ROLE_ARN is missing', () => {
    delete process.env.MICROVM_EXECUTION_ROLE_ARN;
    expect(buildMicrovmConfig()).toBe('MICROVM_EXECUTION_ROLE_ARN env var is not set');
  });

  test('returns error string when MICROVM_INGRESS_NETWORK_CONNECTORS is missing', () => {
    delete process.env.MICROVM_INGRESS_NETWORK_CONNECTORS;
    expect(buildMicrovmConfig()).toBe('MICROVM_INGRESS_NETWORK_CONNECTORS env var is not set');
  });

  test('returns error string when MICROVM_EGRESS_NETWORK_CONNECTORS is missing', () => {
    delete process.env.MICROVM_EGRESS_NETWORK_CONNECTORS;
    expect(buildMicrovmConfig()).toBe('MICROVM_EGRESS_NETWORK_CONNECTORS env var is not set');
  });
});
