import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { loadProviderPlugins, withPluginConnection } from './load.ts';
import { pluginHome, selectPlugin, registrationSource } from './plugin.fixtures.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderPluginHost } from '../sdk/plugins.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';

test('startup loads the factory with options and the host error constructor', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', registrationSource('example'));
  const [registration] = await loadProviderPlugins(env, ['limrun']);
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
  await assert.rejects(loadProviderPlugins(env, ['limrun']), { code: 'INVALID_ARGS' });
  assert.ok(!fs.existsSync(marker));
  selectPlugin(home, 'two', 'other', 'throw new Error("evaluated");', 2);
  await assert.rejects(loadProviderPlugins(env, []), { code: 'INVALID_ARGS' });
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
    await assert.rejects(loadProviderPlugins(env, []), { code: 'INVALID_ARGS' });
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
  await assert.rejects(loadProviderPlugins(env, []), /factory failed/);
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
  const profile = await withPluginConnection(
    'example',
    env,
    async (connection) => await connection.resolve({ flags: {}, stateDir: home, cwd: home, env }),
  );
  assert.equal(profile.profile.platform, 'android');
  assert.ok(fs.existsSync(marker));
  fs.unlinkSync(marker);
  await assert.rejects(
    withPluginConnection(
      'example',
      env,
      async (connection) => await connection.verify({ flags: {}, env }),
    ),
    { code: 'COMMAND_FAILED' },
  );
  assert.ok(fs.existsSync(marker));
});

test('WebDriver plugins use the shared engine and refuse mismatched providers', async () => {
  const { home, env } = pluginHome();
  const source =
    "export default () => ({ webDriver: { provider: 'example', endpoint: 'http://127.0.0.1/', platform: 'android', deviceName: 'example' } });";
  selectPlugin(home, 'example', 'example', source);
  const [registration] = await loadProviderPlugins(env, []);
  assert.equal(registration!.runtime.provider, 'example');
  assert.equal(registration!.platformModule.owner.provider, 'example');
  await registration!.runtime.shutdown();
  const other = pluginHome();
  selectPlugin(other.home, 'example', 'wrong', source);
  await assert.rejects(loadProviderPlugins(other.env, []), { code: 'INVALID_ARGS' });
});
