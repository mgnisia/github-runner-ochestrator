import { createHmac, timingSafeEqual } from 'node:crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const PARAM_NAME = process.env.WEBHOOK_SECRET_PARAM;
const ssm = new SSMClient({});

// Load the secret once and reuse across warm invocations.
let cachedSecret: Promise<string> | undefined;

function getSecret(): Promise<string> {
  if (!cachedSecret) {
    if (!PARAM_NAME) {
      cachedSecret = Promise.reject(new Error('WEBHOOK_SECRET_PARAM env var is not set'));
    } else {
      cachedSecret = ssm
        .send(new GetParameterCommand({ Name: PARAM_NAME, WithDecryption: true }))
        .then((res) => {
          const value = res.Parameter?.Value;
          if (!value) throw new Error(`SSM parameter ${PARAM_NAME} has no value`);
          return value;
        });
    }
  }
  return cachedSecret;
}

// Kick off retrieval during init (cold start) so it is usually ready by the first invoke.
// The no-op catch prevents an init-time failure from becoming an unhandledRejection; the handler
// awaits the same cached promise and surfaces the error as a 500.
getSecret().catch(() => undefined);

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  let secret: string;
  try {
    secret = await getSecret();
  } catch (err) {
    console.error('Failed to load webhook secret:', err);
    return { statusCode: 500, body: 'secret unavailable' };
  }

  const signatureHeader = event.headers?.['x-hub-signature-256'] ?? '';
  const rawBody = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    : Buffer.alloc(0);

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  // Length guard FIRST: timingSafeEqual throws on unequal-length buffers.
  const received = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  const valid = received.length === expectedBuf.length && timingSafeEqual(received, expectedBuf);

  if (!valid) {
    console.warn('Rejected webhook: invalid or missing signature');
    return { statusCode: 401, body: 'invalid signature' };
  }

  console.log('GitHub event:', event.headers?.['x-github-event']);
  console.log('Webhook payload:', rawBody.toString('utf8'));
  return { statusCode: 202, body: 'accepted' };
};
