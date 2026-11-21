import assert from 'node:assert/strict';
import type { ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { test } from 'vitest';
import vphone, { VPHONE_CONNECTION_CAPABILITIES } from './index.ts';
import manifest from '../package.json' with { type: 'json' };

function host(): ProviderPluginHost {
  return {
    env: {},
    options: {},
    clientVersion: '0.0.0-test',
    createError: (code, message, details) => new AppError(code, message, details),
  };
}

test('API-v2 declaration has no credentials and setup performs no process I/O or allocation', async () => {
  let calls = 0;
  const plugin = vphone({
    execFile: async () => {
      calls += 1;
      throw new Error('setup must not execute vphone');
    },
  });

  assert.equal(plugin.apiVersion, 2);
  assert.equal(plugin.provider, 'vphone');
  assert.deepEqual(plugin.credentials, { variables: [] });
  assert.equal(plugin.connection?.capabilities.supportsDeferredAppSelection, false);
  assert.deepEqual(plugin.connection?.capabilities, VPHONE_CONNECTION_CAPABILITIES);
  assert.deepEqual(plugin.connection?.capabilities, manifest.agentDevicePlugin.connection);

  const setup = await plugin.setup(host());
  assert.equal('runtime' in setup, true);
  assert.deepEqual('runtime' in setup && setup.platformModule.owner, {
    kind: 'provider-runtime',
    provider: 'vphone',
    instance: 'vphone',
  });
  assert.equal(calls, 0);
});
