import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readVersion } from '@agent-device/host-kit/version';
import { createEmbeddedProviderRuntimeComposition } from './provider-device-runtimes.ts';
import { builtinLimrunConnection } from './builtin-provider-plugins.ts';

// The built-in candidate is composed by the daemon's own registry, so the case runs the real plugin
// contract with the Limrun SDK stubbed out: nothing here reaches the provider's API.
const limrunSdk = vi.hoisted(() => {
  const clients: Array<Record<string, unknown>> = [];
  const androidList = vi.fn(async () => ({ getPaginatedItems: () => [] }));
  const iosList = vi.fn(async () => ({ getPaginatedItems: () => [] }));
  return { clients, androidList, iosList };
});

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = { list: limrunSdk.iosList };
    readonly androidInstances = { list: limrunSdk.androidList };

    constructor(options: Record<string, unknown>) {
      limrunSdk.clients.push(options);
    }
  },
}));

// The root's own runtime-adapter factory is the runtime half of the built-in composition. Spying on
// it in place, and answering with the real adapters, is what proves a `connect` composes the
// provider's callbacks without setting up a runtime.
const runtimeDependencies = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./sdk/limrun-runtime-dependencies.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sdk/limrun-runtime-dependencies.ts')>();
  return {
    ...original,
    createLimrunRuntimeDependencies: (
      ...args: Parameters<typeof original.createLimrunRuntimeDependencies>
    ) => {
      runtimeDependencies.create(...args);
      return original.createLimrunRuntimeDependencies(...args);
    },
  };
});

afterEach(() => {
  limrunSdk.clients.length = 0;
  limrunSdk.androidList.mockClear();
  limrunSdk.iosList.mockClear();
  runtimeDependencies.create.mockClear();
});

test('an unconfigured built-in Limrun claims its id without an inventory entry or a runtime', async () => {
  const composition = await createEmbeddedProviderRuntimeComposition(
    { env: {}, cwd: process.cwd() },
    [],
  );

  try {
    assert.deepEqual(
      composition.runtimes.map(({ provider }) => provider),
      [],
    );
    assert.deepEqual(
      composition.inventory.map(({ provider }) => provider),
      [],
    );
  } finally {
    await composition.shutdown();
  }
});

test('a configured built-in Limrun registers through the plugin contract with its per-backend credential narrowing', async () => {
  const composition = await createEmbeddedProviderRuntimeComposition(
    {
      env: {
        LIMRUN_API_KEY: 'lim_test_key',
        AGENT_DEVICE_STATE_DIR: mkdtempForTestSync('agent-device-builtin-limrun-'),
      },
      cwd: process.cwd(),
    },
    [],
  );

  try {
    assert.deepEqual(
      composition.inventory
        .filter(({ provider }) => provider === 'limrun')
        .map(({ provider, source, state }) => [provider, source, state]),
      [['limrun', 'builtin', 'active']],
    );
    const registered = composition.runtimes.find(({ provider }) => provider === 'limrun');
    assert.ok(registered, 'a configured built-in registers its runtime');
    assert.deepEqual(
      composition.platformModules
        .filter(({ runtime }) => runtime === registered)
        .map(({ module }) => [module.owner.kind, module.owner.provider]),
      [['provider-runtime', 'limrun']],
    );
    // The fingerprint the daemon and the client both read is the plugin's own declaration: the
    // account variables plus only the leased platform's instance variables.
    assert.deepEqual(
      composition.inventory.find(({ provider }) => provider === 'limrun')?.credentials,
      {
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
      },
    );
  } finally {
    await composition.shutdown();
  }
});

test('the built-in connection answers connect with the provider callbacks and its own verification', async () => {
  const stateDir = mkdtempForTestSync('agent-device-builtin-limrun-connection-');
  const host = {
    env: { LIMRUN_API_KEY: 'lim_test_key', AGENT_DEVICE_STATE_DIR: stateDir },
    cwd: process.cwd(),
  };

  const connection = await builtinLimrunConnection();
  // Composing the connection reads nothing about a runtime: the host adapters are what `setup`
  // asks for, and `connect` never calls it.
  assert.deepEqual(runtimeDependencies.create.mock.calls, []);
  assert.deepEqual(limrunSdk.clients, []);

  // `resolve` runs the provider's own flag, backend, and credential rules.
  const resolved = await connection.resolve({
    flags: { json: true, help: false, version: false, stateDir, platform: 'android' },
    stateDir,
    cwd: host.cwd,
    env: host.env,
  });
  assert.equal(resolved.profile.leaseProvider, 'limrun');
  assert.equal(resolved.profile.leaseBackend, 'android-instance');
  assert.deepEqual(limrunSdk.clients, []);

  // `verify` runs the provider's own read-only account check through the SDK: the credentials of
  // this call's env, this host's version, and only the platform this call selected. No instance is
  // created, and no runtime is set up.
  const verification = await connection.verify({
    flags: { json: true, help: false, version: false, stateDir, platform: 'android' },
    cwd: host.cwd,
    env: host.env,
  });
  assert.equal(verification.service, 'Limrun');
  assert.equal(
    verification.verificationMessage,
    'Credentials and Android instance access verified.',
  );
  assert.deepEqual(limrunSdk.clients, [
    {
      apiKey: 'lim_test_key',
      userAgent: `agent-device-cli/${readVersion()}`,
      timeout: 15_000,
      maxRetries: 0,
    },
  ]);
  assert.deepEqual(limrunSdk.androidList.mock.calls, [[{ limit: 1 }]]);
  assert.deepEqual(limrunSdk.iosList.mock.calls, []);
  assert.deepEqual(runtimeDependencies.create.mock.calls, []);
});

test('the built-in connection verifies the iOS platform another connect call selected', async () => {
  const stateDir = mkdtempForTestSync('agent-device-builtin-limrun-connection-ios-');
  const host = {
    env: { LIMRUN_API_KEY: 'lim_test_key', AGENT_DEVICE_STATE_DIR: stateDir },
    cwd: process.cwd(),
  };
  const connection = await builtinLimrunConnection();
  const verification = await connection.verify({
    flags: { json: true, help: false, version: false, stateDir, platform: 'ios' },
    cwd: host.cwd,
    env: { ...host.env, LIMRUN_REGION: 'eu', LIMRUN_API_KEY: '  lim_test_key  ' },
  });

  assert.equal(verification.verificationMessage, 'Credentials and iOS instance access verified.');
  // The key is read the provider reads it, the region narrows the query, and the platform decides
  // which service is asked.
  assert.equal(limrunSdk.clients[0]?.apiKey, 'lim_test_key');
  assert.deepEqual(limrunSdk.iosList.mock.calls, [[{ limit: 1, region: 'eu' }]]);
  assert.deepEqual(limrunSdk.androidList.mock.calls, []);
});
