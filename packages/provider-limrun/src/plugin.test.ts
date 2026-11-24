import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type {
  ProviderAgentDevicePlugin as AgentDevicePlugin,
  ProviderPluginHost,
} from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import { stubLimrunRuntimeDependencies } from './runtime-dependencies.fixtures.ts';
import { limrunPlugin } from './plugin.ts';
import { syncFolder } from '@limrun/api/folder-sync';

function providerOf<P extends AgentDevicePlugin>(plugin: P) {
  const [contribution] = plugin.contributes;
  if (contribution.kind !== 'provider') throw new Error('expected a provider contribution');
  return contribution as Extract<P['contributes'][number], { kind: 'provider' }>;
}

const sdk = vi.hoisted(() => ({
  shutdown: vi.fn(async () => undefined),
  runtimeCalls: [] as { options: Record<string, unknown>; mode: unknown }[],
  clients: [] as Array<Record<string, unknown>>,
  androidList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
  iosList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
}));

// The runtime module is stubbed so a case reads what the plugin hands the runtime builder without
// constructing a Limrun client. The provider's own runtime contract is what the plugin must satisfy.
vi.mock('./runtime.ts', () => ({
  createLimrunRuntime: (options: Record<string, unknown>, _d: unknown, mode: unknown) => {
    sdk.runtimeCalls.push({ options, mode });
    return {
      runtime: {
        provider: 'limrun',
        prepareRentalRecovery: async () => {},
        shutdown: sdk.shutdown,
        leaseLifecycle: {},
        ownsDevice: () => false,
        getInteractor: () => undefined,
        deviceInventoryProvider: async () => null,
      },
      platformModule: {
        owner: { kind: 'provider-runtime', provider: 'limrun', instance: 'limrun:test' },
        loadRuntime: async () => ({}),
      },
    };
  },
}));

// The SDK is stubbed for the same reason on the other side: a case reads the read-only check's
// request instead of reaching the provider's API.
vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = { list: sdk.androidList };
    readonly iosInstances = { list: sdk.iosList };

    constructor(options: Record<string, unknown>) {
      sdk.clients.push(options);
    }
  },
}));

afterEach(() => {
  sdk.clients.length = 0;
  sdk.androidList.mockClear();
  sdk.iosList.mockClear();
});

function pluginHost(env: Record<string, string | undefined> = {}): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '1.2.3',
    diagnostics: { emit: () => {} },
    createError: (code, message, details) => new AppError(code, message, details),
    runHostCommand: async () => {
      throw new Error('this scenario runs no host commands');
    },
  };
}

function stubDependencies(): LimrunRuntimeDependencies {
  return stubLimrunRuntimeDependencies();
}

test('the plugin declares its provider and the credential variables per lease backend', () => {
  const plugin = limrunPlugin({ createDependencies: () => stubDependencies() });
  assert.equal(plugin.apiVersion, 3);
  assert.equal(providerOf(plugin).provider, 'limrun');
  assert.deepEqual(providerOf(plugin).credentials, {
    variables: [
      'LIMRUN_API_KEY',
      'LIMRUN_REGION',
      'LIMRUN_IOS_MODEL',
      'LIM_IOS_INSTANCE_URL',
      'LIM_IOS_INSTANCE_TOKEN',
      'LIM_ANDROID_INSTANCE_URL',
      'LIM_ANDROID_INSTANCE_TOKEN',
      'LIM_ANDROID_INSTANCE_ADB_URL',
    ],
    byBackend: {
      'ios-instance': [
        'LIMRUN_API_KEY',
        'LIMRUN_REGION',
        'LIMRUN_IOS_MODEL',
        'LIM_IOS_INSTANCE_URL',
        'LIM_IOS_INSTANCE_TOKEN',
      ],
      'android-instance': [
        'LIMRUN_API_KEY',
        'LIMRUN_REGION',
        'LIM_ANDROID_INSTANCE_URL',
        'LIM_ANDROID_INSTANCE_TOKEN',
        'LIM_ANDROID_INSTANCE_ADB_URL',
      ],
    },
  });
});

test('the plugin declares the connection callbacks without setting up any runtime', async () => {
  const plugin = limrunPlugin({ createDependencies: () => stubDependencies() });
  assert.ok(providerOf(plugin).connection, 'the plugin routes connect');
  assert.equal(providerOf(plugin).connection!.capabilities.requiresRemoteDaemon, false);

  // `resolve` runs the provider's own callbacks: the refusal comes from the provider, and nothing
  // here calls setup, loads a runtime, or reads the SDK.
  await assert.rejects(
    async () =>
      await providerOf(plugin).connection?.resolve({
        flags: { json: false, help: false, version: false },
        stateDir: '/state',
        cwd: '/project',
        env: {},
        host: {} as never,
      }),
    { code: 'INVALID_ARGS', message: 'connect limrun requires --platform ios or android.' },
  );
  assert.equal(sdk.runtimeCalls.length, 0);
});

test('verify runs its own SDK check over scoped credentials, version and platform', async () => {
  // The provider owns its read-only check: no caller names the entry it verifies through. The SDK
  // is asked for the credentials of this call's env, the host's version, and this call's platform,
  // and nothing here sets up a runtime.
  const plugin = limrunPlugin({ createDependencies: () => stubDependencies() });

  const verification = await providerOf(plugin).connection?.verify({
    flags: { json: false, help: false, version: false, platform: 'ios' },
    env: { LIMRUN_API_KEY: ' lim_test_key ', LIMRUN_REGION: 'eu', LIMRUN_KEEP_ALIVE: '1' },
    host: pluginHost({ LIMRUN_API_KEY: 'lim_test_key' }),
  });

  assert.equal(verification?.verificationMessage, 'Credentials and iOS instance access verified.');
  assert.deepEqual(sdk.clients, [
    {
      apiKey: 'lim_test_key',
      userAgent: 'agent-device-cli/1.2.3',
      timeout: 15_000,
      maxRetries: 0,
      logLevel: 'off',
    },
  ]);
  // Only the platform this call selected is asked, and the region narrows its query. `keepAlive`
  // leases an instance and has no part in a read-only check.
  assert.deepEqual(sdk.iosList.mock.calls, [[{ limit: 1, region: 'eu' }]]);
  assert.deepEqual(sdk.androidList.mock.calls, []);
  assert.equal(sdk.runtimeCalls.length, 0);
});

test('setup builds the runtime over the credentials, host and HAR directory it was given', async () => {
  const stateDir = mkdtempForTestSync('limrun-plugin-state-');
  const host = {
    ...pluginHost({
      LIMRUN_API_KEY: 'lim_test_key',
      LIMRUN_KEEP_ALIVE: '1',
      LIMRUN_IOS_MODEL: 'ipad',
    }),
    stateDir,
  };
  const dependencies = stubDependencies();
  const createDependencies = vi.fn(() => dependencies);

  const setup = await providerOf(limrunPlugin({ createDependencies })).setup(host);

  if (!('runtime' in setup)) throw new Error('Limrun sets up its own runtime');
  assert.equal(setup.runtime.provider, 'limrun');
  assert.deepEqual(createDependencies.mock.calls, [[host]]);
  assert.deepEqual(sdk.runtimeCalls, [
    {
      options: {
        apiKey: 'lim_test_key',
        region: undefined,
        iosModel: 'ipad',
        keepAlive: true,
        instances: undefined,
        networkHarDir: path.join(stateDir, 'network-har'),
      },
      mode: { includePlatformModule: true },
    },
  ]);
});

test('setup refuses a host that supplies no device capabilities', async () => {
  await assert.rejects(
    async () => {
      await providerOf(limrunPlugin()).setup(pluginHost({ LIMRUN_API_KEY: 'lim_test_key' }));
    },
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.details?.reason, 'provider_host_capability_missing');
      return true;
    },
  );
});

test('setup with only an attached instance builds a runtime without an API key or HAR directory', async () => {
  await providerOf(limrunPlugin({ createDependencies: () => stubDependencies() })).setup(
    pluginHost({ LIM_IOS_INSTANCE_URL: 'https://x/api', LIM_IOS_INSTANCE_TOKEN: 'token' }),
  );
  const options = sdk.runtimeCalls.at(-1)?.options;
  assert.equal(options?.apiKey, undefined);
  assert.deepEqual(options?.instances, {
    ios: { apiUrl: 'https://x/api', token: 'token' },
    android: undefined,
  });
  assert.equal('networkHarDir' in (options ?? {}), false);
});

test('setup reports a dormant claim when the host has no Limrun credentials', async () => {
  const createDependencies = vi.fn(() => stubDependencies());
  const setup = await providerOf(limrunPlugin({ createDependencies })).setup(
    pluginHost({ LIMRUN_REGION: 'eu' }),
  );
  assert.deepEqual(setup, {
    dormant: {
      reason: 'missing_provider_credentials',
      message: 'Limrun requires LIMRUN_API_KEY, or an instance variable set.',
      hint: 'Set LIMRUN_API_KEY for the account, or the full LIM_IOS_INSTANCE_* or LIM_ANDROID_INSTANCE_* set for an existing instance.',
    },
  });
  assert.equal(createDependencies.mock.calls.length, 0);
});

test('setup refuses a partial instance set naming the variable it still needs', async () => {
  const createDependencies = vi.fn(() => stubDependencies());
  await assert.rejects(
    async () => {
      await providerOf(limrunPlugin({ createDependencies })).setup(
        pluginHost({
          LIMRUN_API_KEY: 'lim_test_key',
          LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
          LIM_ANDROID_INSTANCE_TOKEN: 'android-token',
        }),
      );
    },
    {
      code: 'INVALID_ARGS',
      message: 'Limrun instance access is missing LIM_ANDROID_INSTANCE_ADB_URL.',
    },
  );
  assert.equal(createDependencies.mock.calls.length, 0);
});

test('an isolated hosted attachment stops its runtime when the deadline passes', async () => {
  vi.useFakeTimers();
  const plugin = limrunPlugin({ createDependencies: () => stubDependencies() });
  try {
    sdk.shutdown.mockClear();
    const hosted = await providerOf(plugin).setup(
      pluginHost({
        LIM_IOS_INSTANCE_URL: 'https://instance.example',
        LIM_IOS_INSTANCE_TOKEN: 'fixture-token',
        LIMRUN_HOSTED_ATTACHMENT_DEADLINE: new Date(Date.now() + 500).toISOString(),
      }),
    );
    assert.ok(!hosted.dormant);
    await vi.advanceTimersByTimeAsync(499);
    assert.equal(sdk.shutdown.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(sdk.shutdown.mock.calls.length, 1);
    await hosted.dispose?.();
  } finally {
    vi.useRealTimers();
  }
});

test('the hosted plugin refuses an SDK folder-sync redirect and leaves unrelated requests alone', async () => {
  const token = 'fixture-instance-bearer';
  const apiUrl = 'https://instance.example';
  const app = mkdtempForTestSync('limrun-redirect-app-');
  fs.writeFileSync(path.join(app, 'fixture.apk'), 'fixture');
  const next = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.redirect === 'error') throw new TypeError('redirect refused');
    return Response.json({});
  });
  vi.stubGlobal('fetch', next);
  const plugin = limrunPlugin({ createDependencies: () => stubDependencies() });
  const hosted = await providerOf(plugin).setup(
    pluginHost({
      LIM_IOS_INSTANCE_URL: apiUrl,
      LIM_IOS_INSTANCE_TOKEN: token,
      LIMRUN_HOSTED_ATTACHMENT_DEADLINE: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  try {
    await assert.rejects(
      syncFolder(app, {
        apiUrl,
        token,
        udid: 'fixture',
        basisCacheDir: mkdtempForTestSync('limrun-sync-cache-'),
        install: true,
        watch: false,
        launchMode: 'None',
        compression: 'identity',
        log: () => {},
        ignoreFn: () => false,
      }),
    );
    assert.equal(next.mock.calls.length, 1);
    const [, init] = next.mock.calls[0]!;
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    await fetch(apiUrl, { headers: { authorization: 'Bearer unrelated-bearer' } });
    assert.equal(next.mock.calls[1]?.[1]?.redirect, undefined);
  } finally {
    if ('dispose' in hosted) await hosted.dispose?.();
    vi.unstubAllGlobals();
  }
});
