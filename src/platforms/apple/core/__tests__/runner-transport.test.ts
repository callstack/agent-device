import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ExecBackgroundResult } from '../../../../utils/exec.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { RunnerSession } from '../runner/runner-session-types.ts';

const { mockRunCmd, mockUsbmuxPostCommand } = vi.hoisted(() => ({
  mockRunCmd: vi.fn(),
  mockUsbmuxPostCommand: vi.fn(),
}));

vi.mock('../../../../utils/exec.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/exec.ts')>(
    '../../../../utils/exec.ts',
  );
  return {
    ...actual,
    runCmd: mockRunCmd,
  };
});

vi.mock('../runner/runner-usbmux.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner/runner-usbmux.ts')>();
  return {
    ...actual,
    usbmuxRunnerTransport: {
      postCommand: mockUsbmuxPostCommand,
    },
  };
});

import { clearDeviceTunnelIpCache } from '../runner/runner-command-route.ts';
import { sendRunnerCommandOnce, waitForRunner } from '../runner/runner-transport.ts';

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const iosDevice: DeviceInfo = {
  platform: 'apple',
  id: 'device-1',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

const xctestIosDevice: DeviceInfo = {
  ...iosDevice,
  iosPhysicalDeviceBackend: 'xctest',
};

beforeEach(() => {
  clearDeviceTunnelIpCache();
  mockRunCmd.mockReset();
  mockUsbmuxPostCommand.mockReset();
  mockUsbmuxPostCommand.mockResolvedValue(new Response('{}'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('waitForRunner propagates request cancellation without fallback', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    () =>
      waitForRunner(
        iosSimulator,
        8100,
        { command: 'snapshot' },
        undefined,
        5_000,
        undefined,
        signal,
      ),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      const appError = error as AppError;
      assert.equal(appError.code, 'COMMAND_FAILED');
      assert.equal(appError.message, 'request canceled');
      assert.equal(appError.message.includes('Runner did not accept connection'), false);
      return true;
    },
  );
});

test('waitForRunner reuses cached physical-device tunnel IP across commands', async () => {
  stubUsbmuxDeviceUnattached();
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        info: { outcome: 'success' },
        result: { connectionProperties: { tunnelIPAddress: 'fd00::123' } },
      }),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(mockRunCmd.mock.calls.length, 1);
  const fetchCalls = vi.mocked(fetch).mock.calls;
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.[0], 'http://[fd00::123]:8100/command');
  assert.equal(fetchCalls[1]?.[0], 'http://[fd00::123]:8100/command');
});

test('waitForRunner keeps tunnel IP lookup request-local when no tunnel IP is available', async () => {
  stubUsbmuxDeviceUnattached();
  stubSuccessfulFetch();
  mockRunCmd.mockImplementation(async () => ({ exitCode: 1, stdout: '', stderr: '' }));

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://127.0.0.1:8100/command');
});

test('waitForRunner uses simulator fallback within the attempt for ready sessions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }),
  );
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '{"ok":true}', stderr: '' });

  const response = await waitForRunner(
    iosSimulator,
    8100,
    { command: 'uptime' },
    undefined,
    5_000,
    makeReadyRunnerSession(),
  );

  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(vi.mocked(fetch).mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]?.[0], 'xcrun');
  assert.deepEqual(mockRunCmd.mock.calls[0]?.[1]?.slice(0, 5), [
    'simctl',
    'spawn',
    'sim-1',
    '/usr/bin/curl',
    '-s',
  ]);
});

test('waitForRunner invalidates cached tunnel IP when localhost fallback succeeds', async () => {
  stubUsbmuxDeviceUnattached();
  const tunnelIps = ['fd00::123', 'fd00::456'];
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        info: { outcome: 'success' },
        result: { connectionProperties: { tunnelIPAddress: tunnelIps.shift() } },
      }),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  let staleTunnelFailed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://[fd00::123]:8100/command' && staleTunnelFailed) {
        throw new Error('stale tunnel');
      }
      if (url === 'http://[fd00::123]:8100/command') {
        staleTunnelFailed = true;
      }
      return new Response('{}');
    }),
  );

  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);
  await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  const fetchCalls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
  assert.equal(mockRunCmd.mock.calls.length, 2);
  assert.deepEqual(fetchCalls, [
    'http://[fd00::123]:8100/command',
    'http://[fd00::123]:8100/command',
    'http://127.0.0.1:8100/command',
    'http://[fd00::456]:8100/command',
  ]);
});

test('sendRunnerCommandOnce does not retry or simulator fallback after request failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('request timed out after reaching runner');
    }),
  );

  await assert.rejects(() =>
    sendRunnerCommandOnce(iosSimulator, 8100, { command: 'tap', x: 120, y: 240 }, 5_000),
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
  stubUsbmuxDeviceUnattached();
  stubSuccessfulFetch();
  stubTunnelIpLookup('fd00::123');

  const response = await sendRunnerCommandOnce(iosDevice, 8100, { command: 'uptime' }, 5_000);

  assert.equal(response.status, 200);
  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://[fd00::123]:8100/command');
});

test('sendRunnerCommandOnce keeps the usbmux verdict for xctest devices that have no tunnel', async () => {
  stubUsbmuxDeviceUnattached();
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

test('waitForRunner reports the usbmux verdict for xctest devices without retrying', async () => {
  // Regression: an XCTest device has no tunnel, so retrying cannot attach a
  // cable. Before this was terminal, readiness preflight and read-only
  // commands burned the whole connect budget and lost the recovery hint.
  stubUsbmuxDeviceUnattached();
  stubSuccessfulFetch();

  await assert.rejects(
    () => waitForRunner(xctestIosDevice, 8100, { command: 'snapshot' }, undefined, 5_000),
    (error: unknown) => {
      const appError = error as AppError;
      assert.equal(appError.code, 'DEVICE_NOT_FOUND');
      assert.match(String(appError.details?.hint), /Connect the device by cable/);
      assert.equal(appError.message.includes('Runner did not accept connection'), false);
      return true;
    },
  );

  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('waitForRunner routes coredevice physical devices through usbmux first', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const response = await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(response.status, 200);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(mockRunCmd.mock.calls.length, 0);
  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
});

test('waitForRunner falls back to the tunnel route inside the same attempt', async () => {
  stubUsbmuxDeviceUnattached();
  stubSuccessfulFetch();
  stubTunnelIpLookup('fd00::123');

  const response = await waitForRunner(iosDevice, 8100, { command: 'snapshot' }, undefined, 5_000);

  assert.equal(response.status, 200);
  // One usbmux probe, then the tunnel endpoint — no retry round trip in between.
  assert.equal(mockUsbmuxPostCommand.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://[fd00::123]:8100/command');
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
  stubTunnelIpLookup('fd00::123');

  const response = await sendRunnerCommandOnce(iosDevice, 8100, { command: 'uptime' }, 5_000);

  assert.equal(response.status, 200);
  assert.equal(vi.mocked(fetch).mock.calls[0]?.[0], 'http://[fd00::123]:8100/command');
});

function stubUsbmuxDeviceUnattached(): void {
  mockUsbmuxPostCommand.mockRejectedValue(
    new AppError('DEVICE_NOT_FOUND', 'iOS device is not available through usbmux', {
      deviceId: iosDevice.id,
      usbmuxDeviceAttached: false,
      hint: 'Connect the device by cable, trust this Mac, keep it unlocked, and retry.',
    }),
  );
}

function stubTunnelIpLookup(tunnelIp: string): void {
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const jsonPath = args[args.indexOf('--json-output') + 1]!;
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        info: { outcome: 'success' },
        result: { connectionProperties: { tunnelIPAddress: tunnelIp } },
      }),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

function stubSuccessfulFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
}

function makeReadyRunnerSession(): RunnerSession {
  return {
    sessionId: 'ready-session',
    device: iosSimulator,
    deviceId: iosSimulator.id,
    port: 8100,
    xctestrunPath: '/tmp/runner.xctestrun',
    jsonPath: '/tmp/runner.json',
    testPromise: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    child: { pid: 1234, exitCode: null } as ExecBackgroundResult['child'],
    ready: true,
  };
}
