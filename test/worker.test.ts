import { runMicrovmWithRetry } from '../src/microvms';
import type { MicrovmLaunchConfig } from '../src/microvms';

// Make node:zlib synchronous so the entire retry chain runs as microtasks.
// Without this, the real gzip I/O completes AFTER jest.advanceTimersByTime* has already
// run (because it's real async), meaning the retry setTimeout is registered too late and
// fake timers can't fire it.
jest.mock('node:zlib', () => ({
  gzip: (_input: unknown, callback: (err: null, result: Buffer) => void) => {
    callback(null, Buffer.from('mock-compressed'));
  },
}));

// The mock factory is hoisted by Jest above all imports and variable declarations, so any
// variable referenced inside the factory must be created *within* the factory itself.
// We expose sendMock as a named property so tests can reference it via requireMock().
jest.mock('@aws-sdk/client-lambda-microvms', () => {
  const sendMock = jest.fn();
  return {
    LambdaMicrovmsClient: jest.fn(() => ({ send: sendMock })),
    RunMicrovmCommand: jest.fn((args: unknown) => args),
    __sendMock: sendMock,
  };
});

type MockedSdkModule = { __sendMock: jest.Mock };
// jest.requireMock is safe at module scope because jest.mock above is already hoisted.
const { __sendMock: mockSend } = jest.requireMock('@aws-sdk/client-lambda-microvms') as MockedSdkModule;

const CONFIG: MicrovmLaunchConfig = {
  imageIdentifier: 'arn:test',
  executionRoleArn: 'arn:role',
  ingressNetworkConnectors: ['ingress'],
  egressNetworkConnectors: ['egress'],
  maxIdleDurationSeconds: 900,
  suspendedDurationSeconds: 1800,
  maximumDurationInSeconds: 1800,
};

describe('runMicrovmWithRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSend.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('(a) stops on first success — does not exhaust remaining attempts', async () => {
    // Attempt 1 fails; attempt 2 succeeds. Must stop there — no attempt 3.
    mockSend
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ microvmId: 'vm-1', endpoint: 'https://vm-1' });

    const promise = runMicrovmWithRetry(CONFIG, 'jit-config', { attempts: 3, delayMs: 5000 });
    // runAllTimersAsync fires all pending fake setTimeout calls (including retry delays)
    // without blocking on real I/O — gzip is synchronous so everything drains as microtasks.
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ microvmId: 'vm-1', endpoint: 'https://vm-1' });
    // Exactly 2 SDK calls: attempt 1 (fail) + attempt 2 (success). Attempt 3 never fires.
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('(b) exhausts all 3 attempts and rethrows the last error', async () => {
    mockSend.mockRejectedValue(new Error('persistent failure'));

    const promise = runMicrovmWithRetry(CONFIG, 'jit-config', { attempts: 3, delayMs: 5000 });
    // Attach the rejection handler BEFORE advancing timers so the rejection is never
    // "unhandled" in the gap between promise rejection and the await below.
    const assertion = expect(promise).rejects.toThrow('persistent failure');
    await jest.runAllTimersAsync();
    await assertion;

    // All 3 attempts were made.
    expect(mockSend).toHaveBeenCalledTimes(3);
  });
});
