import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

const execActual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const simulatorActual = await vi.importActual<typeof import('../simulator.ts')>('../simulator.ts');

import { openIosApp } from '../app-launch.ts';
import { ensureBootedSimulator } from '../simulator.ts';
import { IOS_SIMULATOR_OPENURL_TIMEOUT_MS } from '../config.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runCmd } from '@agent-device/host-kit/command';
import { assertRejectsAppError } from '../../__tests__/app-error.ts';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
} from './apple-core-stub-helpers.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
});

test('openIosApp custom scheme deep links on iOS devices require app bundle context', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  await assertRejectsAppError(() => openIosApp(device, 'myapp://home'), {
    code: 'INVALID_ARGS',
  });
});

test('openIosApp web URL on iOS device without app falls back to Safari', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await openIosApp(device, 'https://example.com/path');
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          'ios-device-1',
          '--payload-url',
          'https://example.com/path',
          'com.apple.mobilesafari',
        ],
      ]);
    },
  );
});

test('openIosApp custom scheme on iOS device uses active app context', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await openIosApp(device, 'myapp://item/42', { appBundleId: 'com.example.app' });
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          'ios-device-1',
          '--payload-url',
          'myapp://item/42',
          'com.example.app',
        ],
      ]);
    },
  );
});

test('openIosApp captures iOS simulator launch console output when requested', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-console-test-');
  const launchConsolePath = path.join(tmpDir, 'console.log');
  mockEnsureBootedSimulator.mockResolvedValue();

  await withFakeAppleTool(
    (args) => {
      if (args[0] === 'simctl' && args[1] === 'launch') {
        return { stdout: 'console stdout', stderr: 'console stderr\n' };
      }
      return '';
    },
    async ({ calls }) => {
      await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
        appBundleId: 'com.example.app',
        launchConsole: launchConsolePath,
      });
      assert.deepEqual(calls, [['simctl', 'launch', '--console-pty', 'sim-1', 'com.example.app']]);
      assert.equal(
        await fs.readFile(launchConsolePath, 'utf8'),
        'console stdout\nconsole stderr\n',
      );
    },
  );
});

test('openIosApp emits a clean simctl launch when launchArgs is an empty array', async () => {
  mockEnsureBootedSimulator.mockResolvedValue();

  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
        appBundleId: 'com.example.app',
        launchArgs: [],
      });
      assert.deepEqual(calls, [['simctl', 'launch', 'sim-1', 'com.example.app']]);
    },
  );
});

test('openIosApp appends launchArgs after the bundle id on iOS device', async () => {
  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await openIosApp(IOS_TEST_DEVICE, 'MyApp', {
        appBundleId: 'com.example.app',
        launchArgs: ['-FeatureFlag', 'YES'],
      });
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          'ios-device-1',
          'com.example.app',
          '--',
          '-FeatureFlag',
          'YES',
        ],
      ]);
    },
  );
});

test('openIosApp appends launchArgs alongside --payload-url for iOS device deep links', async () => {
  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await openIosApp(IOS_TEST_DEVICE, 'myapp://item/42', {
        appBundleId: 'com.example.app',
        launchArgs: ['-Tracking', 'NO'],
      });
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          'ios-device-1',
          '--payload-url',
          'myapp://item/42',
          'com.example.app',
          '--',
          '-Tracking',
          'NO',
        ],
      ]);
    },
  );
});

test('openIosApp opens custom-scheme iOS simulator URLs directly when launch args are absent', async () => {
  mockEnsureBootedSimulator.mockResolvedValue();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
    appBundleId: 'com.example.app',
    url: 'myapp://item/42',
  });

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.deepEqual(mockRunCmd.mock.calls[0], [
    'xcrun',
    ['simctl', 'openurl', 'sim-1', 'myapp://item/42'],
    { timeoutMs: IOS_SIMULATOR_OPENURL_TIMEOUT_MS },
  ]);
});

test('openIosApp launches iOS simulator app before opening custom-scheme URL with launchArgs', async () => {
  mockEnsureBootedSimulator.mockResolvedValue();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
    appBundleId: 'com.example.app',
    url: 'myapp://item/42',
    launchArgs: ['-FeatureFlag', 'YES'],
  });

  assert.equal(mockRunCmd.mock.calls.length, 2);
  assert.deepEqual(mockRunCmd.mock.calls[0], [
    'xcrun',
    ['simctl', 'launch', 'sim-1', 'com.example.app', '-FeatureFlag', 'YES'],
    {
      allowFailure: true,
    },
  ]);
  assert.deepEqual(mockRunCmd.mock.calls[1], [
    'xcrun',
    ['simctl', 'openurl', 'sim-1', 'myapp://item/42'],
    { timeoutMs: IOS_SIMULATOR_OPENURL_TIMEOUT_MS },
  ]);
});

test('openIosApp launches iOS simulator app before opening https URL with launchArgs', async () => {
  mockEnsureBootedSimulator.mockResolvedValue();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
    appBundleId: 'com.example.app',
    url: 'https://example.com/item/42',
    launchArgs: ['-FeatureFlag', 'YES'],
  });

  assert.equal(mockRunCmd.mock.calls.length, 2);
  assert.deepEqual(mockRunCmd.mock.calls[0], [
    'xcrun',
    ['simctl', 'launch', 'sim-1', 'com.example.app', '-FeatureFlag', 'YES'],
    {
      allowFailure: true,
    },
  ]);
  assert.deepEqual(mockRunCmd.mock.calls[1], [
    'xcrun',
    ['simctl', 'openurl', 'sim-1', 'https://example.com/item/42'],
    { timeoutMs: IOS_SIMULATOR_OPENURL_TIMEOUT_MS },
  ]);
});

test('openIosApp rejects launchArgs combined with bare URL deep link on iOS simulator', async () => {
  mockEnsureBootedSimulator.mockResolvedValue();
  await assertRejectsAppError(
    () =>
      openIosApp(IOS_TEST_SIMULATOR, 'myapp://item/42', {
        launchArgs: ['-FeatureFlag', 'YES'],
      }),
    { code: 'INVALID_ARGS', message: /simctl openurl/ },
  );
});

test('openIosApp rejects launchArgs on macOS', async () => {
  await assertRejectsAppError(
    () =>
      openIosApp(MACOS_TEST_DEVICE, 'TextEdit', {
        launchArgs: ['-FeatureFlag', 'YES'],
      }),
    { code: 'UNSUPPORTED_OPERATION', message: /macOS/ },
  );
});

test('openIosApp with app and URL on iOS device launches app bundle with payload URL', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await openIosApp(device, 'MyApp', {
        appBundleId: 'com.example.app',
        url: 'myapp://screen/to',
      });
      assert.deepEqual(calls, [
        [
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          'ios-device-1',
          '--payload-url',
          'myapp://screen/to',
          'com.example.app',
        ],
      ]);
    },
  );
});
