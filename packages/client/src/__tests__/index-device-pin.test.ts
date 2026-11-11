import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { CommandFlags } from '@agent-device/contracts/command';
import { runCommand, type DevicePin } from '@agent-device/command-surface';
import { createAgentDeviceClient } from '../index.ts';

// #2161: the client enforces the workspace device pin on the finished request, so every surface
// (CLI argv, CLI batch, MCP flat and nested input, remote config) is held to it in one place.

const PIN: DevicePin = {
  selector: { platform: 'ios', device: 'iPad Pro' },
  policySource: { kind: 'project', label: 'project config file /repo/agent-device.json' },
};

function recordingClient(devicePin: DevicePin | undefined) {
  const requests: Array<Parameters<AgentDeviceDaemonTransport>[0]> = [];
  const transport: AgentDeviceDaemonTransport = async (request) => {
    requests.push(request);
    return { ok: true, data: { results: [], executed: 0, total: 0 } };
  };
  return { requests, client: createAgentDeviceClient({}, { transport, devicePin }) };
}

function failsWithPinConflict(expected: { message: RegExp; conflicts: unknown[] }) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error && 'code' in error && 'details' in error);
    assert.equal(error.code, 'INVALID_ARGS');
    assert.match(error.message, expected.message);
    const details = error.details as Record<string, unknown>;
    assert.equal(details.reason, 'device_pin_conflict');
    assert.equal(details.pinSource, 'project config file /repo/agent-device.json');
    assert.deepEqual(details.conflicts, expected.conflicts);
    return true;
  };
}

test('a batch step naming another device fails before the request leaves the client', async () => {
  const { client, requests } = recordingClient(PIN);

  await assert.rejects(
    runCommand(client, 'batch', {
      steps: [
        { command: 'snapshot', input: {} },
        { command: 'open', input: { app: 'com.example.app', device: 'iPhone 16' } },
      ],
    }),
    failsWithPinConflict({
      message:
        /^Batch step 2: device "iPhone 16" conflicts with the device pin from project config file/,
      conflicts: [{ key: 'device', pinned: 'iPad Pro', requested: 'iPhone 16', step: 2 }],
    }),
  );
  assert.equal(requests.length, 0);
});

test('a top-level selector from any layer that contradicts the pin fails', async () => {
  const { client, requests } = recordingClient(PIN);

  await assert.rejects(
    runCommand(client, 'snapshot', { platform: 'android' }),
    failsWithPinConflict({
      message: /^platform "android" conflicts with the device pin/,
      conflicts: [{ key: 'platform', pinned: 'ios', requested: 'android' }],
    }),
  );
  assert.equal(requests.length, 0);
});

test('a batch whose steps repeat, refine, or omit the pin is sent', async () => {
  const { client, requests } = recordingClient(PIN);

  await runCommand(client, 'batch', {
    platform: 'ios',
    device: 'iPad Pro',
    steps: [
      { command: 'snapshot', input: {} },
      { command: 'open', input: { app: 'com.example.app', device: 'iPad Pro' } },
      // A UDID picks one device among several that share the pinned name.
      { command: 'snapshot', input: { udid: 'ABCDEF' } },
    ],
  });

  assert.equal(requests.length, 1);
  assert.equal((requests[0]?.flags as CommandFlags | undefined)?.batchSteps?.length, 3);
});

test('without a pin the client sends a batch step that names another device', async () => {
  const { client, requests } = recordingClient(undefined);

  await runCommand(client, 'batch', {
    steps: [{ command: 'open', input: { app: 'com.example.app', device: 'iPhone 16' } }],
  });

  const steps = (requests[0]?.flags as CommandFlags | undefined)?.batchSteps;
  assert.equal(steps?.[0]?.flags?.device, 'iPhone 16');
});
