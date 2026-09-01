import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { verifyLimrunConnection } from './connection-verification.ts';

const mockState = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
  androidList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
  iosList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = { list: mockState.androidList };
    readonly iosInstances = { list: mockState.iosList };

    constructor(options: Record<string, unknown>) {
      mockState.constructorOptions.push(options);
    }
  },
}));

afterEach(() => {
  mockState.constructorOptions.length = 0;
  vi.clearAllMocks();
});

test('Limrun verification reads the selected instance service without creating an instance', async () => {
  const result = await verifyLimrunConnection({
    apiKey: 'lim_test_key',
    clientVersion: '1.2.3',
    platform: 'android',
  });

  assert.deepEqual(result, {
    provider: 'limrun',
    service: 'Limrun',
    verificationMessage: 'Credentials and Android instance access verified.',
    device: {
      status: 'deferred',
      name: 'Provider-selected Android emulator',
      platform: 'android',
    },
    app: {
      status: 'missing',
      message: 'Run apps to choose an uploaded asset before allocation.',
    },
  });
  assert.deepEqual(mockState.androidList.mock.calls, [[{ limit: 1 }]]);
  assert.equal(mockState.iosList.mock.calls.length, 0);
  assert.equal(mockState.constructorOptions[0]?.apiKey, 'lim_test_key');
  assert.deepEqual(mockState.constructorOptions[0]?.defaultHeaders, {
    'x-agent-device-client': 'agent-device-cli',
    'x-agent-device-version': '1.2.3',
  });
});

test('Limrun verification classifies authentication failures', async () => {
  mockState.iosList.mockRejectedValueOnce(Object.assign(new Error('invalid'), { status: 401 }));

  await assert.rejects(
    verifyLimrunConnection({
      apiKey: 'lim_bad_key',
      clientVersion: '1.2.3',
      platform: 'ios',
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
      assert.doesNotMatch(JSON.stringify(error), /lim_bad_key/);
      return true;
    },
  );
});
