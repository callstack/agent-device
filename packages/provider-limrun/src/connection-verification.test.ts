import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { verifyLimrunConnection } from './connection-verification.ts';

const mockState = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
  androidList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
  iosList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
}));

const instanceClients = vi.hoisted(() => ({
  disconnect: vi.fn(),
  createIos: vi.fn(async (_options: Record<string, unknown>) => ({
    disconnect: instanceClients.disconnect,
  })),
  createAndroid: vi.fn(async (_options: Record<string, unknown>) => ({
    disconnect: instanceClients.disconnect,
  })),
}));

vi.mock('@limrun/api/ios-client', () => ({ createInstanceClient: instanceClients.createIos }));
vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: instanceClients.createAndroid,
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

test('Limrun verification connects to an attached instance instead of the control plane', async () => {
  const android = { apiUrl: 'https://attached.example/api', token: 'tok', adbUrl: 'wss://adb' };
  const result = await verifyLimrunConnection({
    apiKey: 'lim_test_key',
    instances: { android },
    clientVersion: '1.2.3',
    platform: 'android',
  });

  assert.equal(result.device.status, 'verified');
  assert.deepEqual(instanceClients.createAndroid.mock.calls, [
    [{ ...android, logLevel: 'none', maxReconnectAttempts: 0 }],
  ]);
  assert.equal(instanceClients.disconnect.mock.calls.length, 1);
  assert.equal(mockState.constructorOptions.length, 0);
  assert.equal(mockState.androidList.mock.calls.length, 0);
});

test('Limrun verification names the variables to check when an instance rejects access', async () => {
  const cases = [
    {
      platform: 'ios',
      instances: { ios: { apiUrl: 'https://attached/api', token: 'lim_st_secret' } },
      create: instanceClients.createIos,
      variables: /LIM_IOS_INSTANCE_URL and LIM_IOS_INSTANCE_TOKEN,/,
    },
    {
      platform: 'android',
      instances: {
        android: { apiUrl: 'https://attached/api', token: 'lim_st_secret', adbUrl: 'wss://adb' },
      },
      create: instanceClients.createAndroid,
      variables: /LIM_ANDROID_INSTANCE_TOKEN, and LIM_ANDROID_INSTANCE_ADB_URL/,
    },
  ] as const;
  for (const { platform, instances, create, variables } of cases) {
    create.mockRejectedValueOnce(new Error('Unexpected server response: 401'));
    await assert.rejects(
      verifyLimrunConnection({ instances, clientVersion: '1.2.3', platform }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
        assert.match(JSON.stringify(error), variables);
        assert.doesNotMatch(JSON.stringify(error), /lim_st_secret/);
        return true;
      },
    );
  }
});
