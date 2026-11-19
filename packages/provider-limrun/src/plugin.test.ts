import assert from 'node:assert/strict';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { ProviderPluginHost } from '@agent-device/plugins/host';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import { stubLimrunRuntimeDependencies } from './runtime-dependencies.fixtures.ts';
import { limrunPlugin } from './plugin.ts';

const sdk = vi.hoisted(() => ({
  runtimeCalls: [] as { options: Record<string, unknown>; mode: unknown }[],
}));

// The runtime module is stubbed so a case reads what the plugin hands the runtime builder without
// constructing a Limrun client. The provider's own runtime contract is what the plugin must satisfy.
vi.mock('./runtime.ts', () => ({
  createLimrunRuntime: (options: Record<string, unknown>, _d: unknown, mode: unknown) => {
    sdk.runtimeCalls.push({ options, mode });
    return {
      runtime: {
        provider: 'limrun',
        shutdown: async () => undefined,
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

function pluginHost(env: Record<string, string | undefined> = {}): ProviderPluginHost {
  return {
    env,
    options: {},
    clientVersion: '1.2.3',
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
  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.provider, 'limrun');
  assert.deepEqual(plugin.credentials, {
    variables: [
      'LIMRUN_API_KEY',
      'LIMRUN_REGION',
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
  assert.ok(plugin.connection, 'the plugin routes connect');
  assert.equal(plugin.connection.capabilities.requiresRemoteDaemon, false);

  // `resolve` runs the provider's own callbacks: the refusal comes from the provider, and nothing
  // here calls setup, loads a runtime, or reads the SDK.
  await assert.rejects(
    async () =>
      await plugin.connection?.resolve({
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

test('a composed verifier answers verify in place of the provider SDK check', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const verify = vi.fn(
    async (options: Record<string, unknown>): Promise<ProviderConnectionVerification> => {
      seen.push(options);
      return {
        provider: 'limrun',
        service: 'Limrun',
        verificationMessage: 'verified by the composing root',
        device: {
          status: 'deferred',
          name: 'Provider-selected Android emulator',
          platform: 'android',
        },
        app: {
          status: 'missing',
          message: 'Run apps to choose an uploaded asset before allocation.',
        },
      };
    },
  );
  const plugin = limrunPlugin({
    createDependencies: () => stubDependencies(),
    verifyConnection: verify,
  });

  const verification = await plugin.connection?.verify({
    flags: { json: false, help: false, version: false, platform: 'ios' },
    env: { LIMRUN_API_KEY: 'lim_test_key' },
    host: pluginHost({ LIMRUN_API_KEY: 'lim_test_key' }),
  });

  assert.equal(verification?.verificationMessage, 'verified by the composing root');
  // The provider hands the verifier its full credential read, the host's version, and the platform.
  assert.deepEqual(seen, [
    {
      apiKey: 'lim_test_key',
      region: undefined,
      keepAlive: false,
      instances: undefined,
      clientVersion: '1.2.3',
      platform: 'ios',
    },
  ]);
  assert.equal(verify.mock.calls.length, 1);
});

test('setup builds the runtime over the credentials, host and HAR directory it was given', async () => {
  const host = pluginHost({ LIMRUN_API_KEY: 'lim_test_key', LIMRUN_KEEP_ALIVE: '1' });
  const dependencies = stubDependencies();
  const createDependencies = vi.fn(() => dependencies);
  const stateDir = mkdtempForTestSync('limrun-plugin-state-');

  const setup = await limrunPlugin({ createDependencies, stateDir }).setup(host);

  if (!('runtime' in setup)) throw new Error('Limrun sets up its own runtime');
  assert.equal(setup.runtime.provider, 'limrun');
  assert.deepEqual(createDependencies.mock.calls, [[host]]);
  assert.deepEqual(sdk.runtimeCalls, [
    {
      options: {
        apiKey: 'lim_test_key',
        region: undefined,
        keepAlive: true,
        instances: undefined,
        networkHarDir: path.join(stateDir, 'network-har'),
      },
      mode: { includePlatformModule: true },
    },
  ]);
});

test('setup with only an attached instance builds a runtime without an API key or HAR directory', async () => {
  await limrunPlugin({ createDependencies: () => stubDependencies() }).setup(
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

test('setup refuses a host with no Limrun credentials before asking for host adapters', async () => {
  const createDependencies = vi.fn(() => stubDependencies());
  await assert.rejects(
    async () => {
      await limrunPlugin({ createDependencies }).setup(pluginHost({ LIMRUN_REGION: 'eu' }));
    },
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details?.reason, 'missing_provider_credentials');
      return true;
    },
  );
  assert.equal(createDependencies.mock.calls.length, 0);
});

test('setup refuses a partial instance set naming the variable it still needs', async () => {
  const createDependencies = vi.fn(() => stubDependencies());
  await assert.rejects(
    async () => {
      await limrunPlugin({ createDependencies }).setup(
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
