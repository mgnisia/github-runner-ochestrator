import { createSign, randomUUID } from 'node:crypto';

// Stable GA API version; works for both endpoints used here. (The linked doc page renders the header
// as 2026-03-10, but 2022-11-28 is the documented GA value and is accepted by these endpoints.)
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_API_BASE = 'https://api.github.com';

export interface AppCredentials {
  appClientId: string;
  installationId: string | number;
  privateKey: string; // PEM (PKCS#1 or PKCS#8)
}

export interface GenerateJitParams {
  name: string;
  runnerGroupId: number;
  labels: string[];
  workFolder?: string;
}

export interface JitConfig {
  runner: { id: number; name: string; labels: { name: string }[]; ephemeral?: boolean };
  encoded_jit_config: string;
}

type FetchLike = typeof fetch;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a short-lived RS256 App JWT locally (no network). `iss` is the App client id. */
export function mintAppJwt(clientId: string, privateKey: string, nowMs: number = Date.now()): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSec - 60, exp: nowSec + 540, iss: clientId }; // <=10min window, 60s skew
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export function parseAppCredentials(raw: string): AppCredentials {
  const creds = JSON.parse(raw) as AppCredentials;
  if (!creds.appClientId || !creds.installationId || !creds.privateKey) {
    throw new Error('app credentials JSON missing appClientId/installationId/privateKey');
  }
  if (!creds.privateKey.includes('PRIVATE KEY')) {
    throw new Error('app credentials privateKey does not look like a PEM private key');
  }
  return creds;
}

function authedPost(fetchImpl: FetchLike, url: string, bearer: string, body?: unknown): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function getInstallationToken(
  jwt: string,
  installationId: string | number,
  apiBase: string = DEFAULT_API_BASE,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const res = await authedPost(fetchImpl, `${apiBase}/app/installations/${installationId}/access_tokens`, jwt);
  if (res.status !== 201) {
    throw new Error(`installation token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

export async function generateOrgJitConfig(
  installationToken: string,
  org: string,
  params: GenerateJitParams,
  apiBase: string = DEFAULT_API_BASE,
  fetchImpl: FetchLike = fetch
): Promise<JitConfig> {
  const res = await authedPost(
    fetchImpl,
    `${apiBase}/orgs/${org}/actions/runners/generate-jitconfig`,
    installationToken,
    {
      name: params.name,
      runner_group_id: params.runnerGroupId,
      labels: params.labels,
      ...(params.workFolder ? { work_folder: params.workFolder } : {})
    }
  );
  if (res.status !== 201) {
    throw new Error(`generate-jitconfig failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as JitConfig;
}

export function buildRunnerName(runId: number | undefined): string {
  return `gh-runner-${runId ?? 'unknown'}-${randomUUID().slice(0, 8)}`;
}
