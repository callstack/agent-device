import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  iosDevice,
  iosSimulator,
  makeTunnelIpLookup,
  stubSuccessfulFetch,
  usbmuxDeviceUnattachedError,
  xctestIosDevice,
} from './runner-transport.fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { IosPhysicalDeviceRunnerControl } from '../host.ts';

const { mockRunCmd, mockUsbmuxPostCommand } = vi.hoisted(() => ({
  mockRunCmd: vi.fn(),
  mockUsbmuxPostCommand: vi.fn(),
}));

vi.mock('../runner-usbmux.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-usbmux.ts')>();
  return {
    ...actual,
    usbmuxRunnerTransport: {
      postCommand: mockUsbmuxPostCommand,
    },
  };
});

import { clearDeviceTunnelIpCache } from '../runner-command-route.ts';
import { sendRunnerCommandOnce } from '../runner-transport.ts';

// The real `resolveIosPhysicalDeviceControl` resolves the CoreDevice tunnel IP
// through root-level tooling this package cannot reach; a fake control backed
// by `mockRunCmd` reproduces the same devicectl `--json-output` file protocol
// so the shared `makeTunnelIpLookup` fixture keeps working unmodified.
function parseTunnelIp(payload: unknown): string | null {
  const info = (payload as { info?: { outcome?: string } } | null)?.info;
  if (info?.outcome && info.outcome !== 'success') return null;
  const tunnelIp = (
    payload as { result?: { connectionProperties?: { tunnelIPAddress?: unknown } } } | null
  )?.result?.connectionProperties?.tunnelIPAddress;
  return typeof tunnelIp === 'string' && tunnelIp.length > 0 ? tunnelIp : null;
}

function fakeResolveIosPhysicalDeviceControl(device: {
  iosPhysicalDeviceBackend?: string;
  id: string;
}): IosPhysicalDeviceRunnerControl {
  return {
    backend: device.iosPhysicalDeviceBackend === 'xctest' ? 'xctest' : 'coredevice',
    resolveTunnel: async (resolvedDevice) => {
      const jsonPath = path.join(
        os.tmpdir(),
        `runner-transport-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      );
      try {
        await mockRunCmd('xcrun', [
          'devicectl',
          'device',
          'info',
          'details',
          '--device',
          resolvedDevice.id,
          '--json-output',
          jsonPath,
        ]);
        const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as unknown;
        return { tunnelIp: parseTunnelIp(payload) };
      } catch {
        return { tunnelIp: null };
      } finally {
        fs.rmSync(jsonPath, { force: true });
      }
    },
  };
}

beforeEach(() => {
  clearDeviceTunnelIpCache();
  mockRunCmd.mockReset();
  mockUsbmuxPostCommand.mockReset();
  mockUsbmuxPostCommand.mockResolvedValue(new Response('{}'));
  appleRunnerTestHost.update({
    resolveIosPhysicalDeviceControl: fakeResolveIosPhysicalDeviceControl,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('sendRunnerCommandOnce does not retry or simulator fallback after request failure', async () => {
  // fetchWithTimeout does not wrap fetch() failures into an AppError, so this test's
  // real subject is the no-retry/no-fallback behavior around an opaque transport
  // failure — assert identity of the propagated error, not any particular code.
  const fetchError = new Error('request timed out after reaching runner');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw fetchError;
    }),
  );

  await assert.rejects(
    () => sendRunnerCommandOnce(iosSimulator, 8100, { command: 'tap', x: 120, y: 240 }, 5_000),
    (error: unknown) => error === fetchError,
  );

  assert.equal(vi.mocked(fetch).mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('sendRunnerCommandOnce routes xctest physical devices through usbmux', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const response = await sendRunnerCommandOnce(xctestIosDevice, 8100, { command: 'uptime' }, 5_000);

  assert.equal(response.status, 200);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.deepEqual(mockUsbmuxPostCommand.mock.calls[0]?.slice(0, 3), [
    xctestIosDevice.id,
    8100,
    { command: 'uptime' },
  ]);
});

test('sendRunnerCommandOnce routes coredevice physical devices through usbmux first', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const response = await sendRunnerCommandOnce(iosDevice, 8100, { command: 'uptime' }, 5_000);

  assert.equal(response.status, 200);
  assert.equal(fetchMock.mock.calls.length, 0);
  // The devicectl tunnel probe is the cost usbmux-first exists to avoid.
  assert.equal(mockRunCmd.mock.calls.length, 0);
  assert.deepEqual(mockUsbmuxPostCommand.mock.calls[0]?.slice(0, 3), [
    iosDevice.id,
    8100,
    { command: 'uptime' },
  ]);
});

test('sendRunnerCommandOnce falls back to the tunnel route when usbmux reports the device unattached', async () => {
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(makeTunnelIpLookup('fd00::123'));

  const response = await sendRunnerCommandOnce(iosDevice, 8100, { command: 'uptime' }, 5_000);

  assert.equal(response.status, 200);
  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://[fd00::123]:8100/command');
});

test('sendRunnerCommandOnce keeps the usbmux verdict for xctest devices that have no tunnel', async () => {
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());
  stubSuccessfulFetch();

  await assert.rejects(
    () => sendRunnerCommandOnce(xctestIosDevice, 8100, { command: 'uptime' }, 5_000),
    (error: unknown) => {
      assert.equal((error as AppError).code, 'DEVICE_NOT_FOUND');
      return true;
    },
  );
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('falls back to the tunnel when usbmux loses the device mid-connect', async () => {
  // usbmuxd listed the device, then answered Connect with "no such device"
  // (result 2) because it went away in between. That must reach the same
  // fallback as a missing ListDevices entry, or a CoreDevice device fails with
  // a cable hint while its Wi-Fi tunnel is sitting there working.
  mockUsbmuxPostCommand.mockRejectedValue(
    new AppError('DEVICE_NOT_FOUND', 'iOS device is no longer available through usbmux', {
      deviceId: iosDevice.id,
      usbmuxDeviceAttached: false,
      usbmuxResult: 2,
      hint: 'Connect the device by cable, trust this Mac, keep it unlocked, and retry.',
    }),
  );
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(makeTunnelIpLookup('fd00::123'));

  const response = await sendRunnerCommandOnce(iosDevice, 8100, { command: 'uptime' }, 5_000);

  assert.equal(response.status, 200);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://[fd00::123]:8100/command');
});
