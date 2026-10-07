import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { loadProviderPlugins, withPluginConnection } from './load.ts';
import {
  pluginHome,
  selectPlugin,
  registrationSource,
  webDriverPluginSource,
} from './plugin.fixtures.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderPluginHost } from '../sdk/plugins.ts';
import type { DeviceLease, ProviderDeviceRuntime } from '@agent-device/contracts/device';

const realFetch = globalThis.fetch;
const lease: DeviceLease = {
  leaseId: 'lease-1',
  tenantId: 'team-a',
  runId: 'run-a',
  clientId: 'client-a',
  leaseProvider: 'example',
  backend: 'android-instance',
  deviceKey: 'example:device-a',
  createdAt: 1,
  expiresAt: 2,
  heartbeatAt: 1,
};

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
  selectPlugin(home, 'unrelated', 'unrelated', 'throw new Error("unrelated plugin evaluated");');
  const profile = await withPluginConnection(
    'example',
    env,
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
      async (connection) =>
        await connection.verify({ flags: { json: false, help: false, version: false }, env }),
    ),
    { code: 'COMMAND_FAILED' },
  );
  assert.ok(fs.existsSync(marker));
});

test('WebDriver plugins allocate through the shared engine and refuse mismatched providers', async () => {
  const { home, env } = pluginHome();
  const source = webDriverPluginSource('example', ['awsProjectArn']);
  selectPlugin(home, 'example', 'example', source);
  const [registration] = await loadProviderPlugins(env, []);
  const runtime = registration!.runtime;
  assert.equal(runtime.provider, 'example');
  assert.equal(registration!.platformModule.owner.provider, 'example');
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify({ value: { sessionId: 'SESSION1', capabilities: {} } }));
  };
  try {
    await assert.rejects(
      runtime.leaseLifecycle.allocate!(lease, { flags: { awsProjectArn: 'arn:project' } }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.equal(error.details?.provider, 'example');
        assert.deepEqual(error.details?.flags, ['--aws-project-arn']);
        return true;
      },
    );
    assert.deepEqual(requests, []);
    const allocated = await runtime.leaseLifecycle.allocate!(lease, { flags: {} });
    assert.equal(allocated?.sessionId, 'SESSION1');
    assert.deepEqual(requests, ['POST https://webdriver.test/wd/hub/session']);
  } finally {
    await runtime.shutdown();
    globalThis.fetch = realFetch;
  }
  const other = pluginHome();
  selectPlugin(other.home, 'example', 'wrong', source);
  await assert.rejects(loadProviderPlugins(other.env, []), { code: 'INVALID_ARGS' });
});

test('a factory returning a primitive is refused as an invalid plugin', async () => {
  for (const value of ['42', '"runtime"', 'true']) {
    const { home, env } = pluginHome();
    selectPlugin(home, 'example', 'example', `export default () => ${value};`);
    await assert.rejects(loadProviderPlugins(env, []), { code: 'INVALID_ARGS' });
  }
});
