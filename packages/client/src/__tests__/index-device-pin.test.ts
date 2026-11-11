import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import type { CommandFlags } from '@agent-device/contracts/command';
import { runCommand, type DevicePin } from '@agent-device/command-surface';
import { createAgentDeviceClient } from '../index.ts';

const PIN: DevicePin = {
  selector: { platform: 'ios', device: 'iPad Pro' },
  source: { kind: 'project', path: '/repo/agent-device.json' },
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
      // The daemon checks that this identity still matches the pinned name.
      { command: 'snapshot', input: { udid: 'ABCDEF' } },
    ],
  });

  assert.equal(requests.length, 1);
  const flags = requests[0]?.flags as CommandFlags | undefined;
  assert.ok(requests[0]?.meta && 'devicePin' in requests[0].meta);
  assert.deepEqual(requests[0].meta.devicePin, PIN);
  assert.equal(flags?.platform, 'ios');
  assert.equal(flags?.device, 'iPad Pro');
  const steps = flags?.batchSteps;
  assert.equal(steps?.length, 3);
  assert.equal(steps?.[0]?.flags?.device, undefined);
  assert.equal(steps?.[1]?.flags?.device, 'iPad Pro');
  assert.equal(steps?.[2]?.flags?.udid, 'ABCDEF');
});

test('without a pin the client sends a batch step that names another device', async () => {
  const { client, requests } = recordingClient(undefined);

  await runCommand(client, 'batch', {
    steps: [{ command: 'open', input: { app: 'com.example.app', device: 'iPhone 16' } }],
  });

  const steps = (requests[0]?.flags as CommandFlags | undefined)?.batchSteps;
  assert.equal(steps?.[0]?.flags?.device, 'iPhone 16');
});

test('the client supplies pin selectors even when request options contain undefined defaults', async () => {
  const { client, requests } = recordingClient(PIN);
  await runCommand(client, 'snapshot', { platform: undefined, device: undefined });
  assert.equal(requests[0]?.flags?.platform, 'ios');
  assert.equal(requests[0]?.flags?.device, 'iPad Pro');
  assert.ok(requests[0]?.meta && 'devicePin' in requests[0].meta);
  assert.deepEqual(requests[0].meta.devicePin, PIN);
});

test('a name alias and overlapping Apple platform selectors are accepted', async () => {
  const { client, requests } = recordingClient(PIN);
  await runCommand(client, 'snapshot', { device: 'ipad_pro', platform: 'apple' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.flags?.platform, 'ios');
});

test('an Apple-family pin forwards a requested leaf platform', async () => {
  const { client, requests } = recordingClient({ ...PIN, selector: { platform: 'apple' } });
  await runCommand(client, 'snapshot', { platform: 'macos' });
  assert.equal(requests[0]?.flags?.platform, 'macos');
});

for (const [selector, input, conflict] of [
  [
    { platform: 'ios' },
    { serial: 'emulator-5554' },
    { key: 'serial', pinnedKey: 'platform', pinned: 'ios', requested: 'emulator-5554' },
  ],
  [
    { platform: 'android' },
    { udid: 'IPAD-001' },
    { key: 'udid', pinnedKey: 'platform', pinned: 'android', requested: 'IPAD-001' },
  ],
  [
    { udid: 'IPAD-001' },
    { serial: 'emulator-5554' },
    { key: 'serial', pinnedKey: 'udid', pinned: 'IPAD-001', requested: 'emulator-5554' },
  ],
  [
    { serial: 'emulator-5554' },
    { udid: 'IPAD-001' },
    { key: 'udid', pinnedKey: 'serial', pinned: 'emulator-5554', requested: 'IPAD-001' },
  ],
  [
    { udid: 'IPAD-001' },
    { platform: 'android' },
    { key: 'platform', pinnedKey: 'udid', pinned: 'IPAD-001', requested: 'android' },
  ],
  [
    { serial: 'emulator-5554' },
    { platform: 'ios' },
    { key: 'platform', pinnedKey: 'serial', pinned: 'emulator-5554', requested: 'ios' },
  ],
  [
    { platform: 'linux' },
    { udid: 'IPAD-001' },
    { key: 'udid', pinnedKey: 'platform', pinned: 'linux', requested: 'IPAD-001' },
  ],
  [
    { platform: 'web' },
    { serial: 'emulator-5554' },
    { key: 'serial', pinnedKey: 'platform', pinned: 'web', requested: 'emulator-5554' },
  ],
] as const) {
  test(`a pin ${JSON.stringify(selector)} rejects incompatible selector ${JSON.stringify(input)} before transport`, async () => {
    const { client, requests } = recordingClient({ ...PIN, selector });
    await assert.rejects(
      runCommand(client, 'snapshot', input),
      failsWithPinConflict({ message: /conflicts with the device pin/, conflicts: [conflict] }),
    );
    assert.equal(requests.length, 0);
  });
}

test('an incompatible selector in a batch step is rejected before any request is sent', async () => {
  const { client, requests } = recordingClient(PIN);
  await assert.rejects(
    runCommand(client, 'batch', {
      steps: [{ command: 'snapshot', input: { serial: 'emulator-5554' } }],
    }),
    failsWithPinConflict({
      message: /^Batch step 1: serial/,
      conflicts: [
        {
          key: 'serial',
          pinnedKey: 'platform',
          pinned: 'ios',
          requested: 'emulator-5554',
          step: 1,
        },
      ],
    }),
  );
  assert.equal(requests.length, 0);
});

for (const [platform, identity] of [
  ['ios', { udid: 'IPAD-001' }],
  ['macos', { udid: 'MAC-001' }],
  ['android', { serial: 'emulator-5554' }],
  ['harmonyos', { serial: 'HARMONY-001' }],
  ['vega', { serial: 'VEGA-001' }],
] as const) {
  test(`a ${platform} pin accepts a compatible identity selector`, async () => {
    const { client, requests } = recordingClient({ ...PIN, selector: { platform } });
    await runCommand(client, 'snapshot', identity);
    assert.equal(requests.length, 1);
    if ('udid' in identity) {
      assert.equal(requests[0]?.flags?.udid, identity.udid);
    } else {
      assert.equal(requests[0]?.flags?.serial, identity.serial);
    }
  });
}
