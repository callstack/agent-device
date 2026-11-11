import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createAgentDeviceClient } from '@agent-device/client';
import { createCommandToolExecutor } from './command-tools.ts';
import { resolveMcpConfigDefaults } from './tool-input-config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

const supported = { platform: { type: 'string' }, device: { type: 'string' } } as const;

function hostPinnedTo(config: Record<string, unknown>) {
  const home = mkdtempForTestSync('agent-device-mcp-pin-');
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  const configPath = path.join(cwd, 'agent-device.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { cwd, configPath, env: { HOME: home, USERPROFILE: home, AGENT_DEVICE_HOME: home } };
}

// #2161: the pin is operator policy, like the session lock. It is read from config and env only, and
// the client checks it on the finished request, so a model can neither turn it on nor get around it.
test('a tool call reads the pin from operator config, never from tool input', () => {
  const pinned = hostPinnedTo({ platform: 'ios', device: 'iPad Pro', devicePin: true });
  const resolved = resolveMcpConfigDefaults(
    'open',
    { target: 'com.example.app' },
    supported,
    pinned,
  );

  assert.equal(resolved.input.platform, 'ios');
  assert.equal(resolved.input.device, 'iPad Pro');
  assert.equal('devicePin' in resolved.input, false);
  assert.deepEqual(resolved.devicePin?.selector, { platform: 'ios', device: 'iPad Pro' });

  const unpinned = hostPinnedTo({ platform: 'ios', device: 'iPad Pro' });
  const overridden = resolveMcpConfigDefaults('open', { device: 'iPhone 16' }, supported, unpinned);
  assert.equal(overridden.input.device, 'iPhone 16');
  assert.equal(overridden.devicePin, undefined);
});

test('a nested batch step naming another device fails before any daemon request', async () => {
  const { configPath } = hostPinnedTo({ platform: 'ios', device: 'iPad Pro', devicePin: true });
  vi.stubEnv('AGENT_DEVICE_CONFIG', configPath);
  const requests: unknown[] = [];
  const transport: AgentDeviceDaemonTransport = async (request) => {
    requests.push(request);
    return { ok: true, data: {} };
  };
  const executor = createCommandToolExecutor({
    createClient: (config, devicePin) => createAgentDeviceClient(config, { transport, devicePin }),
  });

  const result = await executor.execute('batch', {
    steps: [{ command: 'open', input: { app: 'com.example.app', device: 'iPhone 16' } }],
  });

  assert.equal(result.isError, true);
  assert.equal(requests.length, 0);
  const error = result.structuredContent as Record<string, unknown>;
  assert.equal(
    error.message,
    `Batch step 1: device "iPhone 16" conflicts with the device pin from config file ${configPath}, which pins platform "ios", device "iPad Pro". Edit or remove "devicePin" in that config to target another device.`,
  );
  assert.equal((error.details as { reason?: string }).reason, 'device_pin_conflict');
});
