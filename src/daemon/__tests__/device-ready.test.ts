import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { DeviceInfo } from '../../kernel/device.ts';

vi.mock('../../utils/exec.ts', () => ({
  runCmd: vi.fn(),
  runCmdSync: vi.fn(),
  whichCmd: vi.fn(async () => true),
}));
vi.mock('../../platforms/ios/simulator.ts', () => ({
  ensureBootedSimulator: vi.fn(async () => {}),
}));
vi.mock('../../platforms/android/devices.ts', () => ({
  waitForAndroidBoot: vi.fn(async () => {}),
}));

import { runCmd } from '../../utils/exec.ts';
import { waitForAndroidBoot } from '../../platforms/android/devices.ts';
import { ensureBootedSimulator } from '../../platforms/ios/simulator.ts';
import { ANDROID_EMULATOR, IOS_DEVICE, IOS_SIMULATOR } from '../../__tests__/test-utils/index.ts';
import {
  clearDeviceReadyCacheForTests,
  DEVICE_READY_CACHE_TTL_MS,
  ensureDeviceReady,
  parseIosReadyPayload,
  resolveIosReadyHint,
} from '../device-ready.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);
const mockWaitForAndroidBoot = vi.mocked(waitForAndroidBoot);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
  clearDeviceReadyCacheForTests();
  mockRunCmd.mockReset();
  mockEnsureBootedSimulator.mockReset();
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockWaitForAndroidBoot.mockReset();
  mockWaitForAndroidBoot.mockResolvedValue(undefined);
});

afterEach(() => {
  clearDeviceReadyCacheForTests();
  vi.useRealTimers();
});

test('ensureDeviceReady caches successful simulator readiness checks', async () => {
  const device: DeviceInfo = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' };

  await ensureDeviceReady(device);
  await ensureDeviceReady({ ...device });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(1);
  expect(mockEnsureBootedSimulator).toHaveBeenCalledWith(
    device,
    expect.objectContaining({
      deviceHub: undefined,
      focusExisting: undefined,
    }),
  );
});

test('ensureDeviceReady focuses cached simulator readiness checks when requested', async () => {
  const device: DeviceInfo = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' };

  await ensureDeviceReady(device);
  await ensureDeviceReady({ ...device }, { deviceHub: true, focusExisting: true });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(2);
  expect(mockEnsureBootedSimulator).toHaveBeenLastCalledWith(
    { ...device },
    expect.objectContaining({ deviceHub: true, focusExisting: true }),
  );
});

test('ensureDeviceReady caches successful iOS physical device readiness checks', async () => {
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    await fs.writeFile(
      jsonPath,
      JSON.stringify({
        result: {
          connectionProperties: {
            tunnelState: 'connected',
          },
        },
      }),
    );
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await ensureDeviceReady(IOS_DEVICE);
  await ensureDeviceReady({ ...IOS_DEVICE, simulatorSetPath: '/ignored-for-physical-device' });

  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('ensureDeviceReady includes simulator set path in the cache key', async () => {
  await ensureDeviceReady({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-a' });
  await ensureDeviceReady({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/simset-b' });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady forwards iOS simulator cold boot callback', async () => {
  const onColdBootStart = vi.fn();
  await ensureDeviceReady(IOS_SIMULATOR, { onIosSimulatorColdBootStart: onColdBootStart });

  expect(mockEnsureBootedSimulator).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    expect.objectContaining({ onColdBootStart }),
  );
});

test('ensureDeviceReady expires cached readiness checks after the ttl', async () => {
  await ensureDeviceReady(ANDROID_EMULATOR);
  vi.setSystemTime(new Date(Date.now() + DEVICE_READY_CACHE_TTL_MS - 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR });
  vi.setSystemTime(new Date(Date.now() + 1));
  await ensureDeviceReady({ ...ANDROID_EMULATOR });

  expect(mockWaitForAndroidBoot).toHaveBeenCalledTimes(2);
});

test('ensureDeviceReady does not cache failed readiness checks', async () => {
  mockEnsureBootedSimulator.mockRejectedValueOnce(new Error('boot failed'));

  await expect(ensureDeviceReady(IOS_SIMULATOR)).rejects.toThrow('boot failed');
  await ensureDeviceReady(IOS_SIMULATOR);

  expect(mockEnsureBootedSimulator).toHaveBeenCalledTimes(2);
});

test('parseIosReadyPayload reads tunnelState from direct connectionProperties', () => {
  const parsed = parseIosReadyPayload({
    result: {
      connectionProperties: {
        tunnelState: 'connected',
      },
    },
  });
  assert.equal(parsed.tunnelState, 'connected');
});

test('parseIosReadyPayload reads tunnelState from nested device connectionProperties', () => {
  const parsed = parseIosReadyPayload({
    result: {
      device: {
        connectionProperties: {
          tunnelState: 'connecting',
        },
      },
    },
  });
  assert.equal(parsed.tunnelState, 'connecting');
});

test('parseIosReadyPayload returns empty payload for malformed input', () => {
  assert.deepEqual(parseIosReadyPayload(null), {});
  assert.deepEqual(parseIosReadyPayload({}), {});
  assert.deepEqual(
    parseIosReadyPayload({
      result: { connectionProperties: { tunnelState: 123 } },
    }),
    {},
  );
});

test('resolveIosReadyHint maps known connection errors', () => {
  const connecting = resolveIosReadyHint('', 'Device is busy (Connecting to iPhone)');
  assert.match(connecting, /still connecting/i);

  const coreDeviceTimeout = resolveIosReadyHint('CoreDeviceService timed out', '');
  assert.match(coreDeviceTimeout, /coredevice service/i);
});

test('resolveIosReadyHint falls back to generic guidance', () => {
  const hint = resolveIosReadyHint('unexpected failure', '');
  assert.match(hint, /unlocked/i);
  assert.match(hint, /xcode/i);
});
