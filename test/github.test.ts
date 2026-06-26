import { generateKeyPairSync, verify } from 'node:crypto';
import {
  generateOrgJitConfig,
  getInstallationToken,
  mintAppJwt,
  parseAppCredentials
} from '../src/github';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

test('mintAppJwt produces a verifiable RS256 token with iss + <=10min window', () => {
  const jwt = mintAppJwt('client-123', privateKey, 1_700_000_000_000);
  const [h, p, sig] = jwt.split('.');
  const header = JSON.parse(b64urlToBuf(h).toString());
  const payload = JSON.parse(b64urlToBuf(p).toString());
  expect(header.alg).toBe('RS256');
  expect(payload.iss).toBe('client-123');
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, b64urlToBuf(sig))).toBe(true);
});

test('parseAppCredentials validates required fields and PEM shape', () => {
  expect(() => parseAppCredentials('{}')).toThrow();
  const ok = parseAppCredentials(
    JSON.stringify({ appClientId: 'c', installationId: '1', privateKey: '-----BEGIN PRIVATE KEY-----' })
  );
  expect(ok.appClientId).toBe('c');
});

function fakeResponse(status: number, json: unknown): Response {
  return { status, json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
}

test('getInstallationToken posts to the installation endpoint and returns the token', async () => {
  let calledUrl = '';
  const fetchImpl = (async (url: string) => {
    calledUrl = url;
    return fakeResponse(201, { token: 'ghs_xyz' });
  }) as unknown as typeof fetch;
  const token = await getInstallationToken('jwt', '999', 'https://api.github.com', fetchImpl);
  expect(token).toBe('ghs_xyz');
  expect(calledUrl).toBe('https://api.github.com/app/installations/999/access_tokens');
});

test('generateOrgJitConfig posts the right body and returns encoded_jit_config', async () => {
  let body: any;
  let calledUrl = '';
  const fetchImpl = (async (url: string, init: any) => {
    calledUrl = url;
    body = JSON.parse(init.body);
    return fakeResponse(201, { runner: { id: 1, name: 'r', labels: [] }, encoded_jit_config: 'ENC' });
  }) as unknown as typeof fetch;
  const jit = await generateOrgJitConfig(
    'token',
    'donkersgoed-org',
    { name: 'r', runnerGroupId: 1, labels: ['lambda-microvms'] },
    'https://api.github.com',
    fetchImpl
  );
  expect(jit.encoded_jit_config).toBe('ENC');
  expect(calledUrl).toBe('https://api.github.com/orgs/donkersgoed-org/actions/runners/generate-jitconfig');
  expect(body.runner_group_id).toBe(1);
  expect(body.labels).toEqual(['lambda-microvms']);
});

test('non-201 responses throw', async () => {
  const fetchImpl = (async () => fakeResponse(404, { message: 'nope' })) as unknown as typeof fetch;
  await expect(getInstallationToken('jwt', '1', 'https://api.github.com', fetchImpl)).rejects.toThrow();
});
