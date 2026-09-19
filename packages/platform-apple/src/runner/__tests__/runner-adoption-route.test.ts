import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildRunnerLease, writeRunnerLease, type RunnerLease } from '../runner-lease.ts';
import { tryAdoptRunnerSessionFromLease } from '../runner-adoption.ts';
import { clearDeviceTunnelIpCache } from '../runner-command-route.ts';
import { usbmuxRunnerTransport } from '../runner-usbmux.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { usbmuxDeviceUnattachedError } from './runner-transport.fixtures.ts';
import { runnerResponse } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

vi.mock('../runner-xctestrun.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-xctestrun.ts')>();
  return {
    ...actual,
    resolveExpectedRunnerCacheMetadata: vi.fn(() => ({})),
    resolveRunnerDerivedPath: vi.fn(() => expectedDerived),
  };
});
vi.mock('../runner-usbmux.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-usbmux.ts')>();
  return {
    ...actual,
    usbmuxRunnerTransport: { postCommand: vi.fn() },
  };
});

// Everything below the route decision is faked: usbmuxd's socket, the `devicectl` tunnel lookup, and
// the network. The route decision itself - which endpoint the adoption probe dials for a physical
// device - is the real code under test here, so a probe that quietly fell back to 127.0.0.1 could
// not pass. `runner-adoption.test.ts` mocks the transport and therefore cannot see this.
const mockUsbmuxPostCommand = vi.mocked(usbmuxRunnerTransport.postCommand);
const mockIsProcessAlive = vi.fn((_pid: number) => false);
const mockReadProcessCommand = vi.fn((_pid: number): string | null => null);
const mockReadProcessStartTime = vi.fn((_pid: number): string | null => 'test-process-start');

const RUNNER_PID = 424242;
const RUNNER_PORT = 50700;

const cabledDevice: DeviceInfo = {
  platform: 'apple',
  id: 'adopt-route-cabled',
  name: 'iPhone 17 Pro',
  kind: 'device',
  target: 'mobile',
  appleOs: 'ios',
  iosPhysicalDeviceBackend: 'coredevice',
  booted: true,
};

let leaseDir: string;
let expectedDerived: string;
let fetchUrls: string[];
let tunnelIp: string | null;
let tunnelLookups: number;

beforeEach(() => {
  leaseDir = mkdtempForTestSync('adopt-route-leases-');
  expectedDerived = path.join(mkdtempForTestSync('adopt-route-derived-'), 'DerivedData');
  fetchUrls = [];
  tunnelIp = null;
  tunnelLookups = 0;
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = leaseDir;
  clearDeviceTunnelIpCache();
  mockUsbmuxPostCommand.mockReset();
  mockIsProcessAlive.mockImplementation((pid) => pid === RUNNER_PID);
  mockReadProcessCommand.mockReturnValue(null);
  appleRunnerTestHost.update({
    isProcessAlive: mockIsProcessAlive,
    readProcessCommand: mockReadProcessCommand,
    readProcessStartTime: mockReadProcessStartTime,
    // Backend classification (coredevice vs xctest) stays the real implementation; the tunnel
    // address lookup is the `devicectl` shell-out it hides.
    resolveIosPhysicalDeviceControl: (device) => ({
      ...appleRunnerTestHost.defaults().resolveIosPhysicalDeviceControl(device),
      resolveTunnel: async () => {
        tunnelLookups += 1;
        return { tunnelIp };
      },
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      fetchUrls.push(String(input));
      return runnerResponse({ uptimeMs: 1 });
    }),
  );
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR;
  vi.unstubAllGlobals();
});

function writeDetachedLease(device: DeviceInfo): void {
  const lease: RunnerLease = {
    ...buildRunnerLease({
      deviceId: device.id,
      sessionId: `${device.id}:${RUNNER_PORT}:1`,
      runnerPid: RUNNER_PID,
      port: RUNNER_PORT,
      xctestrunPath: path.join(expectedDerived, 'Build', 'Products', 'env.session.xctestrun'),
      jsonPath: path.join(expectedDerived, 'Build', 'Products', 'env.session.json'),
    }),
    ownerToken: 'detached-owner-99999-deadbeef',
    ownerPid: 99999,
    ownerStartTime: 'not-a-real-start-time',
  };
  writeRunnerLease(lease);
}

test('the adoption probe dials usbmux for a cabled CoreDevice device, never loopback', async () => {
  writeDetachedLease(cabledDevice);
  mockUsbmuxPostCommand.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));

  const session = await tryAdoptRunnerSessionFromLease(cabledDevice, {});

  expect(session).not.toBeNull();
  expect(mockUsbmuxPostCommand.mock.calls.map(([deviceId, port]) => `${deviceId}:${port}`)).toEqual(
    [`${cabledDevice.id}:${RUNNER_PORT}`],
  );
  expect(fetchUrls).toEqual([]);
  // A cabled device must not pay for the tunnel lookup either (#1403).
  expect(tunnelLookups).toBe(0);
});

test('a Wi-Fi CoreDevice device is probed at its tunnel address, not at 127.0.0.1', async () => {
  // usbmuxd never sees a CoreDevice Wi-Fi device (#1403), so the probe has to fall back to the
  // tunnel route the real resolver builds. The loopback endpoint stays in the candidate list as a
  // port-forward fallback, and adoption would only reach it if the tunnel address refused the probe.
  writeDetachedLease(cabledDevice);
  tunnelIp = 'fd18::42';
  mockUsbmuxPostCommand.mockRejectedValue(usbmuxDeviceUnattachedError());

  const session = await tryAdoptRunnerSessionFromLease(cabledDevice, {});

  expect(session).not.toBeNull();
  expect(fetchUrls[0]).toBe(`http://[${tunnelIp}]:${RUNNER_PORT}/command`);
});

test('a lease from a daemon that left no log path still adopts, and the new lease says none', async () => {
  writeDetachedLease(cabledDevice);
  mockUsbmuxPostCommand.mockResolvedValue(runnerResponse({ uptimeMs: 1 }));

  const session = await tryAdoptRunnerSessionFromLease(cabledDevice, {});

  expect(session?.runnerLogPath).toBeUndefined();
  expect(fs.existsSync(path.join(leaseDir, `${cabledDevice.id}.json`))).toBe(true);
});
