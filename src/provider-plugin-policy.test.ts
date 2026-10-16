import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceLease } from '@agent-device/contracts/device';
import { runCmd } from '@agent-device/host-kit/command';
import { changePlugin, installedPlugins } from '@agent-device/plugins/store';
import { loadProviderPlugins } from '@agent-device/plugins/load';
import {
  pluginHome,
  registrationSource,
  selectPlugin,
  webDriverPluginSource,
  writePlugin,
} from '@agent-device/test-kit';
import { PROVIDER_PLUGIN_POLICY, RESERVED_PLUGIN_PROVIDERS } from './provider-plugin-policy.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.doUnmock('@agent-device/provider-webdriver/plugin');
});

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

test('WebDriver plugins allocate through the shared engine and refuse mismatched providers', async () => {
  const { home, env } = pluginHome();
  const source = webDriverPluginSource('example', ['awsProjectArn']);
  selectPlugin(home, 'example', 'example', source);
  const [registration] = await loadProviderPlugins(env, PROVIDER_PLUGIN_POLICY);
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
  }
  const other = pluginHome();
  selectPlugin(other.home, 'example', 'wrong', source);
  await assert.rejects(loadProviderPlugins(other.env, PROVIDER_PLUGIN_POLICY), {
    code: 'INVALID_ARGS',
  });
});

test('a WebDriver plugin supplies connection callbacks and its runtime is released afterwards', async () => {
  const shutdowns: string[] = [];
  vi.resetModules();
  vi.doMock('@agent-device/provider-webdriver/plugin', async (importOriginal) => {
    const original =
      await importOriginal<typeof import('@agent-device/provider-webdriver/plugin')>();
    return {
      ...original,
      createCloudWebDriverRuntime: async (
        ...args: Parameters<typeof original.createCloudWebDriverRuntime>
      ) => {
        const runtime = await original.createCloudWebDriverRuntime(...args);
        const shutdown = runtime.shutdown.bind(runtime);
        runtime.shutdown = async () => {
          shutdowns.push(runtime.provider);
          await shutdown();
        };
        return runtime;
      },
    };
  });
  const { withPluginConnection: withConnection } = await import('@agent-device/plugins/load');
  const { PROVIDER_PLUGIN_POLICY: policy } = await import('./provider-plugin-policy.ts');
  const { home, env } = pluginHome();
  selectPlugin(
    home,
    'example',
    'example',
    webDriverPluginSource(
      'example',
      [],
      "{ resolve: () => ({ profile: { leaseProvider: 'example', platform: 'android' } }), verify: async () => { throw host.createError('COMMAND_FAILED', 'verification failed'); } }",
    ),
  );
  const flags = { json: false, help: false, version: false };
  const resolved = await withConnection(
    'example',
    env,
    policy,
    async (connection) => await connection.resolve({ flags, stateDir: home, cwd: home, env }),
  );
  assert.equal(resolved.profile.platform, 'android');
  assert.deepEqual(shutdowns, ['example']);
  await assert.rejects(
    withConnection(
      'example',
      env,
      policy,
      async (connection) => await connection.verify({ flags, env }),
    ),
    { code: 'COMMAND_FAILED', message: 'verification failed' },
  );
  assert.deepEqual(shutdowns, ['example', 'example']);
});

test('native plugins load without evaluating the WebDriver runtime, WebDriver plugins do', async () => {
  const evaluations = { count: 0 };
  vi.resetModules();
  vi.doMock('@agent-device/provider-webdriver/plugin', async (importOriginal) => {
    evaluations.count += 1;
    return await importOriginal<typeof import('@agent-device/provider-webdriver/plugin')>();
  });
  const { loadProviderPlugins: load } = await import('@agent-device/plugins/load');
  const { PROVIDER_PLUGIN_POLICY: policy } = await import('./provider-plugin-policy.ts');
  const native = pluginHome();
  selectPlugin(native.home, 'example', 'example', registrationSource('example'));
  const [registration] = await load(native.env, policy);
  await registration!.runtime.shutdown();
  assert.equal(evaluations.count, 0);
  const webDriver = pluginHome();
  selectPlugin(webDriver.home, 'example', 'example', webDriverPluginSource('example'));
  const [adapted] = await load(webDriver.env, policy);
  await adapted!.runtime.shutdown();
  assert.equal(evaluations.count, 1);
});

test('bundled and connect provider ids are refused at load before any plugin evaluates', async () => {
  for (const provider of RESERVED_PLUGIN_PROVIDERS) {
    const { home, env } = pluginHome();
    const marker = path.join(home, 'evaluated');
    selectPlugin(
      home,
      'example',
      provider,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
    );
    await assert.rejects(loadProviderPlugins(env, PROVIDER_PLUGIN_POLICY), {
      code: 'INVALID_ARGS',
      message: `Duplicate provider plugin: ${provider}`,
    });
    assert.ok(!fs.existsSync(marker), provider);
  }
});

test('bundled and connect provider ids are refused at install and leave no selection', async () => {
  for (const provider of RESERVED_PLUGIN_PROVIDERS) {
    const { env } = pluginHome();
    vi.mocked(runCmd).mockImplementation(async (_command, _argv, options) => {
      writePlugin(options!.cwd!, 'other', 1, provider);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    await assert.rejects(
      changePlugin('add', 'other', env, PROVIDER_PLUGIN_POLICY.reservedProviders),
      { code: 'INVALID_ARGS', message: `Duplicate provider plugin: ${provider}` },
    );
    assert.deepEqual(installedPlugins(env), [], provider);
  }
});
