import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import { readGesturePayload } from '@agent-device/gestures/gesture-input';
import type { DevicePin } from '@agent-device/command-surface';
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

test('a tool call reads the pin from operator config, never from tool input', () => {
  const pinned = hostPinnedTo({ devicePin: { platform: 'ios', device: 'iPad Pro' } });
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
  const { configPath } = hostPinnedTo({ devicePin: { platform: 'ios', device: 'iPad Pro' } });
  vi.stubEnv('AGENT_DEVICE_CONFIG', configPath);
  const requests: unknown[] = [];
  const transport: AgentDeviceDaemonTransport = async (request) => {
    requests.push(request);
    return { ok: true, data: {} };
  };
  const executor = createCommandToolExecutor({
    structuredContent: 'declared',
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
    `Batch step 1: device "iPhone 16" conflicts with the device pin from config file ${configPath}.`,
  );
  assert.equal((error.details as { reason?: string }).reason, 'device_pin_conflict');
});

test('a devicePin in tool input is rejected before a client exists, and the config pin stays in force', async () => {
  const createdWith: Array<unknown> = [];
  const requests: unknown[] = [];
  const transport: AgentDeviceDaemonTransport = async (request) => {
    requests.push(request);
    return { ok: true, data: {} };
  };
  const executor = createCommandToolExecutor({
    structuredContent: 'declared',
    createClient: (config, devicePin) => {
      createdWith.push(devicePin);
      return createAgentDeviceClient(config, { transport, devicePin });
    },
  });

  // Unpinned host: the model cannot turn the pin on.
  const unpinned = hostPinnedTo({ platform: 'ios', device: 'iPad Pro' });
  vi.stubEnv('AGENT_DEVICE_CONFIG', unpinned.configPath);
  const enable = await executor.execute('open', {
    app: 'com.example.app',
    devicePin: { device: 'iPhone 16' },
  });
  assert.equal(enable.isError, true);

  // Pinned host: the model cannot turn the pin off to retarget.
  const pinned = hostPinnedTo({ devicePin: { platform: 'ios', device: 'iPad Pro' } });
  vi.stubEnv('AGENT_DEVICE_CONFIG', pinned.configPath);
  const disable = await executor.execute('open', {
    app: 'com.example.app',
    device: 'iPhone 16',
    devicePin: { device: 'iPhone 16' },
  });
  assert.equal(disable.isError, true);

  assert.deepEqual(createdWith, []);
  assert.equal(requests.length, 0);

  // Without the stray key, the operator pin is the one the client is built with.
  const blocked = await executor.execute('open', { app: 'com.example.app', device: 'iPhone 16' });
  assert.equal(blocked.isError, true);
  assert.equal(
    ((blocked.structuredContent as { details?: { reason?: string } }).details ?? {}).reason,
    'device_pin_conflict',
  );
  assert.equal(createdWith.length, 1);
  assert.deepEqual((createdWith[0] as DevicePin | undefined)?.selector, {
    platform: 'ios',
    device: 'iPad Pro',
  });
  assert.equal(requests.length, 0);
});

test('a config holdMs never becomes a gesture pan hold; a typed field and gesture tap still apply', () => {
  const gestureFields = { kind: { type: 'string' }, holdMs: { type: 'integer' } } as const;
  const host = hostPinnedTo({ holdMs: 300 });

  const pan = resolveMcpConfigDefaults(
    'gesture',
    { kind: 'pan', origin: { x: 200, y: 420 }, delta: { x: 0, y: 160 }, durationMs: 500 },
    gestureFields,
    host,
  );
  assert.equal('holdMs' in pan.input, false);

  const typed = resolveMcpConfigDefaults(
    'gesture',
    { kind: 'pan', holdMs: 800 },
    gestureFields,
    host,
  );
  assert.equal(typed.input.holdMs, 800);

  const tap = resolveMcpConfigDefaults(
    'gesture',
    {
      kind: 'tap',
      points: [
        { x: 80, y: 300 },
        { x: 200, y: 450 },
      ],
    },
    gestureFields,
    host,
  );
  assert.equal(tap.input.holdMs, 300);

  // A kind that never reads holdMs must not fail on a config default the caller never sent.
  const fling = resolveMcpConfigDefaults(
    'gesture',
    { kind: 'fling', direction: 'up', origin: { x: 200, y: 420 }, distance: 90 },
    gestureFields,
    host,
  );
  assert.equal('holdMs' in fling.input, false);
  assert.doesNotThrow(() => readGesturePayload(fling.input));
  assert.equal('holdMs' in readGesturePayload(fling.input), false);
});
