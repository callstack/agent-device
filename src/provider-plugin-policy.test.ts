import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceLease } from '@agent-device/contracts/device';
import {
  claimProviderIds,
  resolveProviderPlugins,
  startProviderRegistry,
} from '@agent-device/plugins/registry';
import { storePluginCandidates } from '@agent-device/plugins/store';
import { pluginHome, selectPlugin, webDriverPluginSource } from '@agent-device/test-kit';
import { PROVIDER_PLUGIN_POLICY } from './provider-plugin-policy.ts';

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

async function startStoreRegistry(env: NodeJS.ProcessEnv) {
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds([]),
    ...(await storePluginCandidates(env)),
  ]);
  return await startProviderRegistry(resolved, env, PROVIDER_PLUGIN_POLICY);
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a WebDriver plugin allocates through the shared engine under the process policy', async () => {
  const { home, env } = pluginHome();
  selectPlugin(home, 'example', 'example', webDriverPluginSource('example', ['awsProjectArn']));
  const registry = await startStoreRegistry(env);
  const { runtime, platformModule } = registry.registrations[0]!;
  assert.equal(runtime.provider, 'example');
  assert.equal(platformModule.owner.provider, 'example');
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
    await registry.close();
  }
});

test('a WebDriver descriptor missing what the engine needs is listed as an invalid plugin', async () => {
  const { home, env } = pluginHome();
  selectPlugin(
    home,
    'example',
    'example',
    "export default () => ({ webDriver: { provider: 'example' } });",
  );
  const registry = await startStoreRegistry(env);
  assert.deepEqual(registry.registrations, []);
  assert.equal(registry.inventory[0]!.state, 'failed');
  assert.equal(registry.inventory[0]!.error?.reason, 'invalid_plugin');
});
