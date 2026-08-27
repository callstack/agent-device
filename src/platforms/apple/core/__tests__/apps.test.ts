import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/retry')>();
  return { ...actual, retryWithPolicy: vi.fn(actual.retryWithPolicy) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

const execActual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const retryActual = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const simulatorActual = await vi.importActual<typeof import('../simulator.ts')>('../simulator.ts');

import {
  closeIosApp,
  installIosInstallablePath,
  openIosApp,
  pushIosNotification,
  readIosClipboardText,
  resolveIosApp,
  resolveIosSimulatorDeepLinkBundleId,
  screenshotIos,
  setIosSetting,
} from '../apps.ts';
import { withMockedMacOsHelper } from './macos-helper-test-utils.ts';
import { quitMacOsApp, resolveMacOsHelperPackageRootFrom } from '../../os/macos/helper.ts';
import { ensureBootedSimulator } from '../simulator.ts';
import { IOS_DEVICE_INSTALL_TIMEOUT_MS, IOS_SIMULATOR_TERMINATE_TIMEOUT_MS } from '../config.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { retryWithPolicy } from '@agent-device/host-kit/retry';
import { PNG } from '@agent-device/capture-kit/png';
import { assertRejectsAppError } from '../../../../__tests__/test-utils/app-error.ts';
import {
  withFakeAppleTool,
  type FakeAppleToolResponse,
} from '../../../../__tests__/test-utils/fake-apple-tool.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
} from './apple-core-stub-helpers.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRetryWithPolicy = vi.mocked(retryWithPolicy);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockRetryWithPolicy.mockImplementation(retryActual.retryWithPolicy);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
});

// The fake tool provider installs through the production withAppleToolProvider
// scope, so `calls` records the flat invocations the PATH-stub scripts saw.

const BOOTED_SIM_LIST_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'sim-1', state: 'Booted' }] },
});

function isSimctlListDevices(args: string[]): boolean {
  return (
    args[0] === 'simctl' && args.includes('list') && args.includes('devices') && args.includes('-j')
  );
}

function unexpectedArgs(args: string[]): FakeAppleToolResponse {
  return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
}

function isSimctlMainScreenScale(args: string[]): boolean {
  return args[0] === 'simctl' && args[1] === 'getenv' && args[3] === 'SIMULATOR_MAINSCREEN_SCALE';
}

function isSimctlScreenshot(args: string[]): boolean {
  return (
    args[0] === 'simctl' && args[1] === 'io' && args[2] === 'sim-1' && args[3] === 'screenshot'
  );
}

function isDevicectlDevice(args: string[], ...subcommand: string[]): boolean {
  return (
    args[0] === 'devicectl' &&
    args[1] === 'device' &&
    subcommand.every((word, index) => args[2 + index] === word)
  );
}

test('resolveMacOsHelperPackageRootFrom finds helper package from source and dist-like paths', async () => {
  const repoRoot = await mkdtempForTest('agent-device-helper-root-');
  const helperRoot = path.join(repoRoot, 'apple', 'macos-helper');
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(path.join(helperRoot, 'Package.swift'), '// test\n', 'utf8');

  try {
    const sourceLike = path.join(repoRoot, 'src', 'platforms', 'ios', 'macos-helper.ts');
    const distLike = path.join(repoRoot, 'dist', 'src', 'platforms', 'ios', 'macos-helper.js');

    assert.equal(resolveMacOsHelperPackageRootFrom(sourceLike), helperRoot);
    assert.equal(resolveMacOsHelperPackageRootFrom(distLike), helperRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test('AGENT_DEVICE_MACOS_HELPER_BIN rejects relative override paths', async () => {
  const previousHelperPath = process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
  process.env.AGENT_DEVICE_MACOS_HELPER_BIN = './agent-device-macos-helper';

  try {
    await assert.rejects(() => quitMacOsApp('com.example.App'), { code: 'INVALID_ARGS' });
  } finally {
    if (previousHelperPath === undefined) {
      delete process.env.AGENT_DEVICE_MACOS_HELPER_BIN;
    } else {
      process.env.AGENT_DEVICE_MACOS_HELPER_BIN = previousHelperPath;
    }
  }
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

test('screenshotIos retries simulator capture timeouts and eventually succeeds', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-screenshot-retry-test-');
  const outPath = path.join(tmpDir, 'screen.png');

  // Dimensions divisible by 3 so the implicit density-1 rescale (against the stub's native
  // scale 3) stays exact. This test is about capture retry, not resolution, so the source is
  // small rather than the 1206x2622 iPhone 16 Pro frame it used to allocate and resize —
  // 3.2 megapixels to prove arithmetic that 34k pixels prove just as well.
  const sourcePng = PNG.sync.write(new PNG({ width: 126, height: 273 }));

  mockRetryWithPolicy.mockImplementation(async (fn, policy, options) => {
    assert.ok(policy);
    assert.ok(options);
    assert.equal(options.phase, 'ios_simulator_screenshot');
    assert.equal(policy.maxAttempts, 5);
    assert.equal(policy.baseDelayMs, 1_000);
    assert.equal(policy.maxDelayMs, 5_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      try {
        return await fn({
          attempt,
          maxAttempts: policy.maxAttempts,
          deadline: options.deadline,
        });
      } catch (error) {
        lastError = error;
        if (!policy.shouldRetry?.(error, attempt)) throw error;
      }
    }
    throw lastError;
  });

  let screenshotAttempts = 0;
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (isSimctlMainScreenScale(args)) return '3\n';
      if (isSimctlScreenshot(args)) {
        screenshotAttempts += 1;
        if (screenshotAttempts < 3) {
          return {
            stderr: 'Detected file type from extension: PNG\nTimeout waiting for screen surfaces\n',
            exitCode: 60,
          };
        }
        writeFileSync(args[4] ?? '', sourcePng);
        return '';
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await screenshotIos(IOS_TEST_SIMULATOR, outPath);
      const png = PNG.sync.read(await fs.readFile(outPath));
      assert.equal(png.width, 42);
      assert.equal(png.height, 91);
      assert.equal(screenshotAttempts, 3);

      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.filter((line) => line === `simctl io sim-1 screenshot ${outPath}`).length,
        3,
        'should retry screenshot command until success',
      );
      assert.deepEqual(
        calls.filter((args) => args[0] === 'open'),
        [],
        'should not focus simulator host app while retrying screenshots',
      );
    },
  );
});

test('screenshotIos keeps requested simulator pixel density', async () => {
  const tmpDir = await mkdtempForTest('agent-device-ios-screenshot-density-');
  const outPath = path.join(tmpDir, 'screen.png');

  // Both dimensions divisible by 3 so the 2/3 rescale (density 2 against the stub's native
  // scale 3) stays exact. What this pins is that ratio, not an absolute resolution: it used
  // to allocate and resize a 1206x2622 iPhone 16 Pro frame — 3.2 megapixels, ~90x more than
  // the arithmetic needs.
  const sourcePng = PNG.sync.write(new PNG({ width: 126, height: 273 }));

  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (isSimctlMainScreenScale(args)) return '3\n';
      if (isSimctlScreenshot(args)) {
        writeFileSync(args[4] ?? '', sourcePng);
        return '';
      }
      return unexpectedArgs(args);
    },
    async () => {
      await screenshotIos(IOS_TEST_SIMULATOR, outPath, { pixelDensity: 2 });
      const png = PNG.sync.read(await fs.readFile(outPath));
      assert.equal(png.width, 84);
      assert.equal(png.height, 182);
    },
  );
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
          'com.apple.mobilesafari',
          '--payload-url',
          'https://example.com/path',
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
          'com.example.app',
          '--payload-url',
          'myapp://item/42',
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
          'com.example.app',
          '--payload-url',
          'myapp://item/42',
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
    undefined,
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
    undefined,
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
    undefined,
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

test('readIosClipboardText rejects physical devices', async () => {
  await assertRejectsAppError(() => readIosClipboardText(IOS_TEST_DEVICE), {
    code: 'UNSUPPORTED_OPERATION',
  });
});

test('closeIosApp on macOS uses helper quit for bundle identifiers', async () => {
  await withMockedMacOsHelper(
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"',
      "cat <<'JSON'",
      '{"ok":true,"data":{"bundleId":"com.example.foobar","running":false,"terminated":false,"forceTerminated":false}}',
      'JSON',
      '',
    ].join('\n'),
    async ({ tmpDir }) => {
      const argsLogPath = path.join(tmpDir, 'args.log');
      const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

      try {
        await closeIosApp(MACOS_TEST_DEVICE, 'com.example.foobar');
        const logged = await fs.readFile(argsLogPath, 'utf8');
        assert.equal(logged, 'app\nquit\n--bundle-id\ncom.example.foobar\n');
      } finally {
        if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
        else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
      }
    },
    { tempPrefix: 'agent-device-macos-close-helper-test-' },
  );
});

test('closeIosApp on iOS simulator bounds simctl terminate', async () => {
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

  await closeIosApp(IOS_TEST_SIMULATOR, 'com.example.foobar');

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]?.[0], 'xcrun');
  assert.deepEqual(mockRunCmd.mock.calls[0]?.[1], [
    'simctl',
    'terminate',
    'sim-1',
    'com.example.foobar',
  ]);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.allowFailure, true);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.timeoutMs, IOS_SIMULATOR_TERMINATE_TIMEOUT_MS);
});

test('quitMacOsApp rejects invalid bundle identifiers before invoking helper', async () => {
  await assert.rejects(() => quitMacOsApp('not a bundle id'), /reverse-DNS form/i);
});

test('installIosInstallablePath on iOS physical device uses extended devicectl install timeout', async () => {
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

  await installIosInstallablePath(IOS_TEST_DEVICE, '/tmp/Sample.app');

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]?.[0], 'xcrun');
  assert.deepEqual(mockRunCmd.mock.calls[0]?.[1], [
    'devicectl',
    'device',
    'install',
    'app',
    '--device',
    'ios-device-1',
    '/tmp/Sample.app',
  ]);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.allowFailure, true);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.timeoutMs, IOS_DEVICE_INSTALL_TIMEOUT_MS);
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
          'com.example.app',
          '--payload-url',
          'myapp://screen/to',
        ],
      ]);
    },
  );
});

test('pushIosNotification uses simctl push with temporary payload file', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  };

  let capturedPayload: string | undefined;
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'push') {
        capturedPayload = readFileSync(args[4] ?? '', 'utf8');
        return '';
      }
      return '';
    },
    async ({ calls }) => {
      await pushIosNotification(device, 'com.example.app', { aps: { alert: 'hello', badge: 4 } });
      const pushCall = calls.find((args) => args[0] === 'simctl' && args[1] === 'push');
      assert.ok(pushCall);
      assert.equal(pushCall[2], 'sim-1');
      assert.equal(pushCall[3], 'com.example.app');
      assert.match(pushCall[4] ?? '', /payload\.apns$/);
      assert.deepEqual(JSON.parse(capturedPayload ?? ''), { aps: { alert: 'hello', badge: 4 } });
    },
  );
});

test('resolveIosApp resolves app display name on iOS physical devices', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  await withFakeAppleTool(
    (args) => {
      if (isDevicectlDevice(args, 'info', 'apps')) {
        const jsonOut = args[args.indexOf('--json-output') + 1];
        writeFileSync(
          jsonOut ?? '',
          '{"result":{"apps":[{"bundleIdentifier":"com.apple.Maps","name":"Maps"},{"bundleIdentifier":"com.example.demo","name":"Demo"}]}}\n',
        );
        return '';
      }
      return unexpectedArgs(args);
    },
    async () => {
      const bundleId = await resolveIosApp(device, 'Maps');
      assert.equal(bundleId, 'com.apple.Maps');
    },
  );
});

test('resolveIosApp caches display-name bundle matches but bypasses exact bundle ids', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-cache-1',
    name: 'iPhone Cache',
    kind: 'simulator',
    booted: true,
  };

  await withFakeAppleTool(
    (args) => {
      if (args[0] === 'simctl' && args[1] === 'listapps') {
        return '{"com.example.cachemaps":{"CFBundleDisplayName":"Cache Maps"}}';
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const first = await resolveIosApp(device, 'Cache Maps');
      const second = await resolveIosApp(device, 'Cache Maps');
      const exact = await resolveIosApp(device, 'com.example.cachemaps');

      assert.equal(first, 'com.example.cachemaps');
      assert.equal(second, 'com.example.cachemaps');
      assert.equal(exact, 'com.example.cachemaps');

      assert.equal(
        calls.filter((args) => args[0] === 'simctl' && args[1] === 'listapps').length,
        1,
      );
    },
  );
});

test('resolveIosSimulatorDeepLinkBundleId maps custom URL scheme to installed user app', async () => {
  const appPath = '/fake/ReactNavigationExample.app';
  const runnerPath = '/fake/AgentDeviceRunner.app';
  const listing = JSON.stringify({
    'com.callstack.agentdevice.runner': {
      ApplicationType: 'User',
      CFBundleDisplayName: 'AgentDeviceRunner',
      Path: runnerPath,
    },
    'org.reactnavigation.playground': {
      ApplicationType: 'User',
      CFBundleDisplayName: 'React Navigation Example',
      Path: appPath,
    },
  });

  await withFakeAppleTool(
    (args) => {
      if (args[0] === 'simctl' && args[1] === 'listapps') return listing;
      if (args[0] === 'plutil' && args[1] === '-convert') {
        const plistPath = args[5] ?? '';
        if (
          plistPath.endsWith('AgentDeviceRunner.app/Info.plist') ||
          plistPath.endsWith('ReactNavigationExample.app/Info.plist')
        ) {
          return '{"CFBundleURLTypes":[{"CFBundleURLSchemes":["rne"]}]}';
        }
        return '{}';
      }
      return unexpectedArgs(args);
    },
    async () => {
      const bundleId = await resolveIosSimulatorDeepLinkBundleId(
        IOS_TEST_SIMULATOR,
        'rne://navigator-layout',
      );
      assert.equal(bundleId, 'org.reactnavigation.playground');
    },
  );
});

test('installIosInstallablePath invalidates cached display-name bundle matches', async () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-cache-install-1',
    name: 'iPhone Cache',
    kind: 'simulator',
    booted: true,
  };
  mockEnsureBootedSimulator.mockResolvedValue(undefined);

  let installed = false;
  await withFakeAppleTool(
    (args) => {
      if (args[0] === 'simctl' && args[1] === 'listapps') {
        return installed
          ? '{"com.example.installedcachemaps":{"CFBundleDisplayName":"Cache Maps"}}'
          : '{"com.example.cachemaps":{"CFBundleDisplayName":"Cache Maps"}}';
      }
      if (args[0] === 'simctl' && args[1] === 'install') {
        installed = true;
        return '';
      }
      return unexpectedArgs(args);
    },
    async () => {
      const before = await resolveIosApp(device, 'Cache Maps');
      await installIosInstallablePath(device, '/fake/Cache.app');
      const after = await resolveIosApp(device, 'Cache Maps');

      assert.equal(before, 'com.example.cachemaps');
      assert.equal(after, 'com.example.installedcachemaps');
    },
  );
});

test('setIosSetting faceid match uses simctl biometric match', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match face') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'faceid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match face'), true, flat.join('; '));
    },
  );
});

test('setIosSetting faceid retries alternate biometric argument order', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match face') return { exitCode: 2 };
      if (args.join(' ') === 'simctl biometric match sim-1 face') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'faceid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match face'), true, flat.join('; '));
      assert.equal(flat.includes('simctl biometric match sim-1 face'), true, flat.join('; '));
    },
  );
});

test('setIosSetting touchid match uses simctl biometric match finger', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match finger') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match finger'), true, flat.join('; '));
    },
  );
});

test('setIosSetting touchid retries touch modality when finger fails', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl biometric sim-1 match finger') return { exitCode: 2 };
      if (args.join(' ') === 'simctl biometric match sim-1 finger') return { exitCode: 2 };
      if (args.join(' ') === 'simctl biometric sim-1 match touch') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl biometric sim-1 match finger'), true, flat.join('; '));
      assert.equal(flat.includes('simctl biometric match sim-1 finger'), true, flat.join('; '));
      assert.equal(flat.includes('simctl biometric sim-1 match touch'), true, flat.join('; '));
    },
  );
});

test('setIosSetting touchid reports unsupported when simctl biometric is unavailable', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return { stderr: 'unknown subcommand biometric', exitCode: 1 };
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match'), {
        code: 'UNSUPPORTED_OPERATION',
        message: /Touch ID simulation is not supported/,
      });
    },
  );
});

test('setIosSetting touchid keeps COMMAND_FAILED for operational failures', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return { stderr: 'Failed to boot simulator service', exitCode: 1 };
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'touchid', 'match'), {
        code: 'COMMAND_FAILED',
        message: /Failed to simulate touchid/,
      });
    },
  );
});

test('setIosSetting appearance toggle queries current osascript appearance on macOS', async () => {
  await withFakeAppleTool(
    (args) => {
      if (args[0] !== 'osascript' || args[1] !== '-e') return unexpectedArgs(args);
      const script = args[2] ?? '';
      if (script.includes('get dark mode')) return 'true';
      if (script.includes('set dark mode to false')) return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(MACOS_TEST_DEVICE, 'appearance', 'toggle');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.some((line) => line.includes('get dark mode')),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.some((line) => line.includes('set dark mode to false')),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission grant accessibility uses macOS helper', async () => {
  await withMockedMacOsHelper(
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"',
      "cat <<'JSON'",
      '{"ok":true,"data":{"target":"accessibility","action":"grant","granted":true,"requested":true,"openedSettings":false}}',
      'JSON',
      '',
    ].join('\n'),
    async ({ tmpDir }) => {
      const argsLogPath = path.join(tmpDir, 'args.log');
      const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

      try {
        const result = await setIosSetting(MACOS_TEST_DEVICE, 'permission', 'grant', undefined, {
          permissionTarget: 'accessibility',
        });
        const logged = await fs.readFile(argsLogPath, 'utf8');
        assert.equal(logged, 'permission\ngrant\naccessibility\n');
        assert.deepEqual(result, {
          action: 'grant',
          granted: true,
          openedSettings: false,
          requested: true,
          target: 'accessibility',
        });
      } finally {
        if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
        else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
      }
    },
    { tempPrefix: 'agent-device-macos-permission-grant-test-' },
  );
});

test('setIosSetting rejects unsupported macOS permission deny action', async () => {
  await assertRejectsAppError(
    () =>
      setIosSetting(MACOS_TEST_DEVICE, 'permission', 'deny', undefined, {
        permissionTarget: 'accessibility',
      }),
    { code: 'INVALID_ARGS', message: /Unsupported macOS setting: permission/i },
  );
});

test('setIosSetting rejects unsupported macOS wifi setting with explicit subset guidance', async () => {
  await assert.rejects(
    () => setIosSetting(MACOS_TEST_DEVICE, 'wifi', 'on'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Unsupported macOS setting: wifi/i);
      assert.match(
        (error as AppError).message,
        /wifi\|airplane\|location\|animations remain unsupported on macOS/i,
      );
      return true;
    },
  );
});

test('setIosSetting location set sends simulator latitude and longitude', async () => {
  mockEnsureBootedSimulator.mockResolvedValue(undefined);

  await withFakeAppleTool(
    () => '',
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'location', 'set', undefined, {
        latitude: 37.3349,
        longitude: -122.009,
      });
      assert.deepEqual(calls, [['simctl', 'location', 'sim-1', 'set', '37.3349,-122.009']]);
    },
  );
});

test('setIosSetting appearance toggle flips current simulator appearance', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 appearance') return 'dark';
      if (args.join(' ') === 'simctl ui sim-1 appearance light') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'appearance', 'toggle');
      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl ui sim-1 appearance'), true, flat.join('; '));
      assert.equal(flat.includes('simctl ui sim-1 appearance light'), true, flat.join('; '));
    },
  );
});

test('setIosSetting appearance toggle rejects unsupported current appearance output', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl ui sim-1 appearance') return 'unsupported';
      return '';
    },
    async () => {
      await assertRejectsAppError(() => setIosSetting(IOS_TEST_SIMULATOR, 'appearance', 'toggle'), {
        code: 'COMMAND_FAILED',
        message: /Unable to determine current iOS appearance/,
      });
    },
  );
});

test('setIosSetting permission grant calendar uses simctl privacy calendar target', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      // simctl privacy help falls through to the fake's canned service listing.
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
      if (args.join(' ') === 'simctl privacy sim-1 grant calendar com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'calendar',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 grant calendar com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting clear-app-state wipes iOS simulator app data container', async () => {
  const containerPath = await mkdtempForTest('agent-device-ios-clear-app-state-container-');
  await fs.mkdir(path.join(containerPath, 'Documents'), { recursive: true });
  await fs.writeFile(path.join(containerPath, 'Documents', 'db.sqlite'), 'db');
  await fs.writeFile(path.join(containerPath, 'Library.plist'), 'prefs');

  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args.join(' ') === 'simctl terminate sim-1 com.example.app') return '';
      if (args.join(' ') === 'simctl get_app_container sim-1 com.example.app data') {
        return `${containerPath}\n`;
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      const result = await setIosSetting(
        IOS_TEST_SIMULATOR,
        'clear-app-state',
        'clear',
        'com.example.app',
      );
      assert.equal(result?.cleared, true);
      assert.equal(result?.bundleId, 'com.example.app');
      assert.deepEqual(await fs.readdir(containerPath), []);

      const flat = calls.map((args) => args.join(' '));
      assert.equal(flat.includes('simctl terminate sim-1 com.example.app'), true, flat.join('; '));
      assert.equal(
        flat.includes('simctl get_app_container sim-1 com.example.app data'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission grant photos limited maps to photos-add', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
      if (args.join(' ') === 'simctl privacy sim-1 grant photos-add com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'photos',
        permissionMode: 'limited',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 grant photos-add com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission rejects mode for non-photos target', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      return unexpectedArgs(args);
    },
    async () => {
      await assertRejectsAppError(
        () =>
          setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'camera',
            permissionMode: 'limited',
          }),
        { code: 'INVALID_ARGS', message: /mode is only supported for photos/i },
      );
    },
  );
});

test('setIosSetting permission reset notifications falls back to reset all when direct reset is blocked', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
      if (args.join(' ') === 'simctl privacy sim-1 reset notifications com.example.app') {
        return { stderr: 'Failed to reset access\nOperation not permitted', exitCode: 1 };
      }
      if (args.join(' ') === 'simctl privacy sim-1 reset all com.example.app') return '';
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 reset notifications com.example.app'),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.includes('simctl privacy sim-1 reset all com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission deny notifications returns unsupported on runtimes that block it', async () => {
  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args[1] === 'privacy' && args[2] === 'help') return undefined;
      if (args.join(' ') === 'simctl privacy sim-1 revoke notifications com.example.app') {
        return { stderr: 'Failed to revoke access\nOperation not permitted', exitCode: 1 };
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await assertRejectsAppError(
        () =>
          setIosSetting(IOS_TEST_SIMULATOR, 'permission', 'deny', 'com.example.app', {
            permissionTarget: 'notifications',
          }),
        {
          code: 'UNSUPPORTED_OPERATION',
          message: /does not support setting notifications permission/i,
        },
      );
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.includes('simctl privacy sim-1 revoke notifications com.example.app'),
        true,
        flat.join('; '),
      );
    },
  );
});

test('setIosSetting permission rejects service missing from simctl privacy help', async () => {
  // A distinct simulator set path busts the module-level privacy-services
  // cache, whose key is `PATH + set path` — the PATH half no longer varies
  // now that no PATH stubbing happens, so the set path must.
  const device: DeviceInfo = { ...IOS_TEST_SIMULATOR, simulatorSetPath: '/fake/privacy-help-set' };
  const CUSTOM_PRIVACY_HELP = `Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

        service
             The service:
                 camera - Allow access to camera.
                 microphone - Allow access to audio input.`;

  await withFakeAppleTool(
    (args) => {
      if (isSimctlListDevices(args)) return BOOTED_SIM_LIST_JSON;
      if (args[0] === 'simctl' && args.includes('privacy') && args.includes('help')) {
        return CUSTOM_PRIVACY_HELP;
      }
      return unexpectedArgs(args);
    },
    async ({ calls }) => {
      await assertRejectsAppError(
        () =>
          setIosSetting(device, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'calendar',
          }),
        { code: 'UNSUPPORTED_OPERATION', message: /does not support service "calendar"/i },
      );
      const flat = calls.map((args) => args.join(' '));
      assert.equal(
        flat.some((line) => line.includes('privacy help')),
        true,
        flat.join('; '),
      );
      assert.equal(
        flat.some((line) => line.includes('grant calendar')),
        false,
        flat.join('; '),
      );
    },
  );
});
