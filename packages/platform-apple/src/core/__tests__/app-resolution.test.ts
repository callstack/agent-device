import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

const { mockRunSimctl } = vi.hoisted(() => ({ mockRunSimctl: vi.fn() }));

vi.mock('../apps-simctl.ts', () => ({ runSimctl: mockRunSimctl }));

import {
  detectSoleRunningIosSimulatorApp,
  findIosSimulatorInstalledApp,
} from '../app-resolution.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

const bootedSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 16',
  kind: 'simulator',
  booted: true,
};

beforeEach(() => {
  mockRunSimctl.mockReset();
  mockRunSimctl.mockResolvedValue({
    stdout: JSON.stringify({
      'com.example.demo': { CFBundleDisplayName: 'Demo' },
      'com.apple.Preferences': { CFBundleDisplayName: 'Settings' },
    }),
  });
});

test('findIosSimulatorInstalledApp verifies exact bundle ids and app-name aliases', async () => {
  assert.equal(
    await findIosSimulatorInstalledApp(bootedSimulator, 'com.example.demo'),
    'com.example.demo',
  );
  assert.equal(
    await findIosSimulatorInstalledApp(bootedSimulator, 'Settings'),
    'com.apple.Preferences',
  );
  assert.equal(
    await findIosSimulatorInstalledApp(bootedSimulator, 'com.example.missing'),
    undefined,
  );
});

test('findIosSimulatorInstalledApp does not probe a stopped simulator', async () => {
  assert.equal(
    await findIosSimulatorInstalledApp({ ...bootedSimulator, booted: false }, 'com.example.demo'),
    undefined,
  );
  assert.equal(mockRunSimctl.mock.calls.length, 0);
});

function mockLaunchctlAndListapps(runningBundleIds: string[]): void {
  mockRunSimctl.mockImplementation(async (_device: DeviceInfo, args: string[]) => {
    if (args[0] === 'spawn') {
      const lines = runningBundleIds.map(
        (bundleId, index) => `${1000 + index}\t0\tUIKitApplication:${bundleId}[abcd][rb-legacy]`,
      );
      // Non-UIKitApplication launchd jobs (system daemons) are mixed in on a
      // real device and must be ignored, not just absent.
      return {
        exitCode: 0,
        stdout: `PID\tStatus\tLabel\n-\t0\tcom.apple.cfprefsd\n${lines.join('\n')}`,
      };
    }
    return {
      stdout: JSON.stringify({
        'com.example.demo': { CFBundleDisplayName: 'Demo' },
        'com.apple.Preferences': { CFBundleDisplayName: 'Settings' },
      }),
    };
  });
}

test('detectSoleRunningIosSimulatorApp cross-references launchctl against installed apps', async () => {
  // com.apple.family is a launchd job that shows up as UIKitApplication but
  // is not a real installed app (not in `simctl listapps`) — it must be
  // filtered out, leaving Preferences as the sole confident candidate.
  mockLaunchctlAndListapps(['com.apple.Preferences', 'com.apple.family']);

  assert.deepEqual(await detectSoleRunningIosSimulatorApp(bootedSimulator), {
    bundleId: 'com.apple.Preferences',
    name: 'Settings',
  });
});

test('detectSoleRunningIosSimulatorApp refuses to guess between two running apps', async () => {
  mockLaunchctlAndListapps(['com.apple.Preferences', 'com.example.demo']);

  assert.equal(await detectSoleRunningIosSimulatorApp(bootedSimulator), undefined);
});

test('detectSoleRunningIosSimulatorApp returns undefined when nothing is running', async () => {
  mockLaunchctlAndListapps([]);

  assert.equal(await detectSoleRunningIosSimulatorApp(bootedSimulator), undefined);
});

test('detectSoleRunningIosSimulatorApp treats a failed probe as inconclusive', async () => {
  mockRunSimctl.mockImplementation(async (_device: DeviceInfo, args: string[]) => {
    if (args[0] === 'spawn') return { exitCode: 1, stdout: '' };
    return {
      stdout: JSON.stringify({ 'com.apple.Preferences': { CFBundleDisplayName: 'Settings' } }),
    };
  });

  assert.equal(await detectSoleRunningIosSimulatorApp(bootedSimulator), undefined);
});

test('detectSoleRunningIosSimulatorApp catches a rejecting launchctl probe (timeout/spawn failure)', async () => {
  mockRunSimctl.mockImplementation(async (_device: DeviceInfo, args: string[]) => {
    if (args[0] === 'spawn') throw new Error('xcrun timed out after 3000ms');
    return {
      stdout: JSON.stringify({ 'com.apple.Preferences': { CFBundleDisplayName: 'Settings' } }),
    };
  });

  assert.equal(await detectSoleRunningIosSimulatorApp(bootedSimulator), undefined);
});

test('detectSoleRunningIosSimulatorApp catches a rejecting listapps probe (timeout/spawn failure)', async () => {
  mockRunSimctl.mockImplementation(async (_device: DeviceInfo, args: string[]) => {
    if (args[0] === 'spawn') {
      return {
        exitCode: 0,
        stdout:
          'PID\tStatus\tLabel\n1000\t0\tUIKitApplication:com.apple.Preferences[abcd][rb-legacy]',
      };
    }
    throw new Error('xcrun timed out after 3000ms');
  });

  assert.equal(await detectSoleRunningIosSimulatorApp(bootedSimulator), undefined);
});

test('detectSoleRunningIosSimulatorApp bounds the listapps probe with a timeout', async () => {
  mockLaunchctlAndListapps(['com.apple.Preferences']);

  await detectSoleRunningIosSimulatorApp(bootedSimulator);

  const listappsCall = mockRunSimctl.mock.calls.find(([, args]) => args[0] === 'listapps');
  assert.equal(typeof listappsCall?.[2]?.timeoutMs, 'number');
  assert.ok((listappsCall?.[2]?.timeoutMs ?? 0) > 0);
});

test('detectSoleRunningIosSimulatorApp does not probe a stopped simulator', async () => {
  assert.equal(
    await detectSoleRunningIosSimulatorApp({ ...bootedSimulator, booted: false }),
    undefined,
  );
  assert.equal(mockRunSimctl.mock.calls.length, 0);
});
