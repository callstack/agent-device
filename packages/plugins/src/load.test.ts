import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  loadProviderPlugins,
  withPluginConnection,
  type PluginLoadPolicy,
  type ProviderPluginRegistration,
} from './load.ts';
import { pluginHome, registrationSource, selectPlugin } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderPluginHost } from './host.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';

const policy = (reservedProviders: readonly string[] = []): PluginLoadPolicy => ({
  reservedProviders,
  adaptFactoryResult: () => undefined,
});

test('startup loads the factory with options and the host error constructor', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', registrationSource('example'));
  const [registration] = await loadProviderPlugins(env, policy(['limrun']));
  const runtime = registration!.runtime as ProviderDeviceRuntime & ProviderPluginHost;
  assert.deepEqual(runtime.options, { region: 'eu' });
  assert.ok(runtime.createError('INVALID_ARGS', 'bad profile') instanceof AppError);
});

test('duplicate providers and incompatible ABI refuse before executing any plugin', async () => {
  const { home, env } = pluginHome();
  const marker = path.join(home, 'evaluated');
  selectPlugin(
    home,
    'one',
    'limrun',
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
  );
  await assert.rejects(loadProviderPlugins(env, policy(['limrun'])), { code: 'INVALID_ARGS' });
  assert.ok(!fs.existsSync(marker));
  selectPlugin(home, 'two', 'other', 'throw new Error("evaluated");', 2);
  await assert.rejects(loadProviderPlugins(env, policy()), { code: 'INVALID_ARGS' });
  assert.ok(!fs.existsSync(marker));
});

test('startup failure cleans up constructed runtimes, including malformed owners', async () => {
  for (const instance of ["'test'", 'undefined', '42', '" "']) {
    const { home, env } = pluginHome();
    const first = path.join(home, 'first-shutdown');
    const invalid = path.join(home, 'invalid-shutdown');
    selectPlugin(home, 'one', 'one', registrationSource('one', first));
    const source = registrationSource(instance === "'test'" ? 'wrong' : 'two', invalid).replace(
      "instance: 'test'",
      `instance: ${instance}`,
    );
    selectPlugin(home, 'two', 'two', source);
    await assert.rejects(loadProviderPlugins(env, policy()), { code: 'INVALID_ARGS' });
    assert.ok(fs.existsSync(first));
    assert.ok(fs.existsSync(invalid));
  }
});

test('cleanup throwing synchronously preserves the factory failure', async () => {
  const { home, env } = pluginHome();
  const marker = path.join(home, 'shutdown');
  const source = registrationSource('one').replace(
    'shutdown: async () => {  }',
    'shutdown: () => { fs.writeFileSync(host.env.AGENT_DEVICE_HOME + "/shutdown", "shutdown"); throw new Error("cleanup"); }',
  );
  selectPlugin(home, 'one', 'one', source);
  selectPlugin(home, 'two', 'two', 'export default () => { throw new Error("factory failed"); };');
  await assert.rejects(loadProviderPlugins(env, policy()), /factory failed/);
  assert.ok(fs.existsSync(marker));
});

test('connection callbacks run from the installed plugin and always release runtimes', async () => {
  const { home, env } = pluginHome();
  const marker = path.join(home, 'shutdown');
  const source = registrationSource('example', marker).replace(
    'platformModule:',
    "connection: { resolve: () => ({ profile: { leaseProvider: 'example', platform: 'android' } }), verify: async () => { throw host.createError('COMMAND_FAILED', 'verification failed'); } }, platformModule:",
  );
  selectPlugin(home, 'example', 'example', source);
  selectPlugin(home, 'unrelated', 'unrelated', 'throw new Error("unrelated plugin evaluated");');
  const profile = await withPluginConnection(
    'example',
    env,
    policy(),
    async (connection) =>
      await connection.resolve({
        flags: { json: false, help: false, version: false },
        stateDir: home,
        cwd: home,
        env,
      }),
  );
  assert.equal(profile.profile.platform, 'android');
  assert.ok(fs.existsSync(marker));
  fs.unlinkSync(marker);
  await assert.rejects(
    withPluginConnection(
      'example',
      env,
      policy(),
      async (connection) =>
        await connection.verify({ flags: { json: false, help: false, version: false }, env }),
    ),
    { code: 'COMMAND_FAILED' },
  );
  assert.ok(fs.existsSync(marker));
});

test('the supplied policy adapts a foreign factory result and its failure releases earlier runtimes', async () => {
  const { home, env } = pluginHome();
  const first = path.join(home, 'first-shutdown');
  selectPlugin(home, 'one', 'one', registrationSource('one', first));
  selectPlugin(home, 'adapted', 'adapted', 'export default () => ({ foreign: true });');
  const contexts: unknown[] = [];
  const adapted = (provider: string): ProviderPluginRegistration =>
    ({
      runtime: {
        provider,
        ownsDevice: () => false,
        getInteractor: () => undefined,
        deviceInventoryProvider: async () => [],
        leaseLifecycle: {},
        shutdown: async () => {},
      },
      platformModule: {
        owner: { kind: 'provider-runtime', provider, instance: 'test' },
        loadRuntime: async () => {
          throw new Error('lazy');
        },
      },
    }) as unknown as ProviderPluginRegistration;
  const adaptForeign = (provider: string): PluginLoadPolicy => ({
    reservedProviders: [],
    adaptFactoryResult: (result, { plugin, host }) => {
      if (typeof result !== 'object' || result === null || !('foreign' in result)) return undefined;
      contexts.push({ plugin, options: host.options });
      return adapted(provider);
    },
  });
  const registrations = await loadProviderPlugins(env, adaptForeign('adapted'));
  assert.deepEqual(
    registrations.map(({ runtime }) => runtime.provider),
    ['one', 'adapted'],
  );
  assert.deepEqual(contexts, [
    { plugin: { name: 'adapted', provider: 'adapted' }, options: { region: 'eu' } },
  ]);
  assert.ok(!fs.existsSync(first));
  await assert.rejects(loadProviderPlugins(env, adaptForeign('other')), {
    code: 'INVALID_ARGS',
  });
  assert.ok(fs.existsSync(first));
});

test('a factory returning a primitive is refused as an invalid plugin', async () => {
  for (const value of ['42', '"runtime"', 'true']) {
    const { home, env } = pluginHome();
    selectPlugin(home, 'example', 'example', `export default () => ${value};`);
    await assert.rejects(loadProviderPlugins(env, policy()), { code: 'INVALID_ARGS' });
  }
});
