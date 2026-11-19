import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createEmbeddedProviderRuntimeComposition } from './provider-device-runtimes.ts';
import { builtinLimrunConnection } from './builtin-provider-plugins.ts';

// The built-in candidate is composed by the daemon's own registry, so the case runs the real plugin
// contract with the Limrun SDK stubbed out: nothing here reaches the provider's API.
vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
    readonly androidInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
    readonly assets = { list: vi.fn(async () => []) };
  },
}));

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

test('the built-in connection answers connect with the provider callbacks and the root verifier', async () => {
  const stateDir = mkdtempForTestSync('agent-device-builtin-limrun-connection-');
  const host = {
    env: { LIMRUN_API_KEY: 'lim_test_key', AGENT_DEVICE_STATE_DIR: stateDir },
    cwd: process.cwd(),
  };

  const connection = await builtinLimrunConnection(host);
  // `resolve` runs the provider's own flag, backend, and credential rules.
  const resolved = await connection.resolve({
    flags: { json: true, help: false, version: false, stateDir, platform: 'android' },
    stateDir,
    cwd: host.cwd,
    env: host.env,
  });
  assert.equal(resolved.profile.leaseProvider, 'limrun');
  assert.equal(resolved.profile.leaseBackend, 'android-instance');

  // `verify` reaches the SDK through the root's published verification entry and runs the
  // read-only account check the stubbed SDK above answers; no instance is created.
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
});
