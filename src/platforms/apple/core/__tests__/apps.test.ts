import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('../../../../utils/retry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/retry.ts')>();
  return { ...actual, retryWithPolicy: vi.fn(actual.retryWithPolicy) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

const execActual = await vi.importActual<typeof import('../../../../utils/exec.ts')>(
  '../../../../utils/exec.ts',
);
const retryActual = await vi.importActual<typeof import('../../../../utils/retry.ts')>(
  '../../../../utils/retry.ts',
);
const simulatorActual = await vi.importActual<typeof import('../simulator.ts')>('../simulator.ts');

import {
  closeIosApp,
  installIosApp,
  installIosInstallablePath,
  openIosApp,
  pushIosNotification,
  readIosClipboardText,
  reinstallIosApp,
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
import { runCmd } from '../../../../utils/exec.ts';
import { retryWithPolicy } from '../../../../utils/retry.ts';
import { PNG } from '../../../../utils/png.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
  withMockedXcrun,
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

test('resolveMacOsHelperPackageRootFrom finds helper package from source and dist-like paths', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-helper-root-'));
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

  await assert.rejects(
    () => openIosApp(device, 'myapp://home'),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      return true;
    },
  );
});

test('screenshotIos retries simulator capture timeouts and eventually succeeds', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-ios-screenshot-retry-test-'),
  );
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const openPath = path.join(tmpDir, 'open');
  const commandLogPath = path.join(tmpDir, 'commands.log');
  const screenshotCountPath = path.join(tmpDir, 'screenshot-attempts.count');
  const outPath = path.join(tmpDir, 'screen.png');
  const sourcePngPath = path.join(tmpDir, 'source.png');

  // Dimensions divisible by 3 so the implicit density-1 rescale (against the stub's native
  // scale 3) stays exact. This test is about capture retry, not resolution, so the source is
  // small rather than the 1206x2622 iPhone 16 Pro frame it used to allocate and resize —
  // 3.2 megapixels to prove arithmetic that 34k pixels prove just as well (1176ms -> 233ms).
  await fs.writeFile(sourcePngPath, PNG.sync.write(new PNG({ width: 126, height: 273 })));

  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'echo "__XCRUN__ $*" >> "$AGENT_DEVICE_TEST_COMMAND_LOG"',
      'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then',
      '  echo \'{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "getenv" ] && [ "$3" = "sim-1" ] && [ "$4" = "SIMULATOR_MAINSCREEN_SCALE" ]; then',
      '  echo "3"',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$3" = "sim-1" ] && [ "$4" = "screenshot" ]; then',
      '  count=0',
      '  if [ -f "$AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE" ]; then',
      '    count=$(cat "$AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE")',
      '  fi',
      '  count=$((count + 1))',
      '  echo "$count" > "$AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE"',
      '  if [ "$count" -lt 3 ]; then',
      '    echo "Detected file type from extension: PNG" >&2',
      '    echo "Timeout waiting for screen surfaces" >&2',
      '    exit 60',
      '  fi',
      '  cp "$AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE" "$5"',
      '  exit 0',
      'fi',
      'echo "unexpected xcrun args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);
  await fs.writeFile(
    openPath,
    '#!/bin/sh\necho "__OPEN__ $*" >> "$AGENT_DEVICE_TEST_COMMAND_LOG"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(openPath, 0o755);

  const previousPath = process.env.PATH;
  const previousCommandLog = process.env.AGENT_DEVICE_TEST_COMMAND_LOG;
  const previousScreenshotCountFile = process.env.AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE;
  const previousScreenshotSourceFile = process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_COMMAND_LOG = commandLogPath;
  process.env.AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE = screenshotCountPath;
  process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE = sourcePngPath;
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

  try {
    await screenshotIos(IOS_TEST_SIMULATOR, outPath);
    const png = PNG.sync.read(await fs.readFile(outPath));
    assert.equal(png.width, 42);
    assert.equal(png.height, 91);
    assert.equal(await fs.readFile(screenshotCountPath, 'utf8'), '3\n');

    const logLines = (await fs.readFile(commandLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(
      logLines.filter((line) => line === '__XCRUN__ simctl io sim-1 screenshot ' + outPath).length,
      3,
      'should retry screenshot command until success',
    );
    assert.equal(
      logLines.filter(
        (line) =>
          line === '__OPEN__ -a Device Hub' ||
          line === '__OPEN__ -a Simulator' ||
          line === '__OPEN__ -g -a Device Hub' ||
          line === '__OPEN__ -g -a Simulator',
      ).length,
      0,
      'should not focus simulator host app while retrying screenshots',
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousCommandLog === undefined) delete process.env.AGENT_DEVICE_TEST_COMMAND_LOG;
    else process.env.AGENT_DEVICE_TEST_COMMAND_LOG = previousCommandLog;
    if (previousScreenshotCountFile === undefined)
      delete process.env.AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE;
    else process.env.AGENT_DEVICE_TEST_SCREENSHOT_COUNT_FILE = previousScreenshotCountFile;
    if (previousScreenshotSourceFile === undefined)
      delete process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE;
    else process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE = previousScreenshotSourceFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}, 10_000);

test('screenshotIos keeps requested simulator pixel density', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-screenshot-density-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const outPath = path.join(tmpDir, 'screen.png');
  const sourcePngPath = path.join(tmpDir, 'source.png');

  // Both dimensions divisible by 3 so the 2/3 rescale (density 2 against the stub's native
  // scale 3) stays exact. What this pins is that ratio, not an absolute resolution: it used
  // to allocate and resize a 1206x2622 iPhone 16 Pro frame — 3.2 megapixels, ~90x more than
  // the arithmetic needs (1021ms -> 34ms).
  await fs.writeFile(sourcePngPath, PNG.sync.write(new PNG({ width: 126, height: 273 })));
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then',
      '  echo \'{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "getenv" ] && [ "$3" = "sim-1" ] && [ "$4" = "SIMULATOR_MAINSCREEN_SCALE" ]; then',
      '  echo "3"',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$3" = "sim-1" ] && [ "$4" = "screenshot" ]; then',
      '  cp "$AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE" "$5"',
      '  exit 0',
      'fi',
      'echo "unexpected xcrun args: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousScreenshotSourceFile = process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE = sourcePngPath;

  try {
    await screenshotIos(IOS_TEST_SIMULATOR, outPath, { pixelDensity: 2 });
    const png = PNG.sync.read(await fs.readFile(outPath));
    assert.equal(png.width, 84);
    assert.equal(png.height, 182);
  } finally {
    process.env.PATH = previousPath;
    if (previousScreenshotSourceFile === undefined)
      delete process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE;
    else process.env.AGENT_DEVICE_TEST_SCREENSHOT_SOURCE_FILE = previousScreenshotSourceFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp web URL on iOS device without app falls back to Safari', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-safari-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  try {
    await openIosApp(device, 'https://example.com/path');
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'ios-device-1',
      'com.apple.mobilesafari',
      '--payload-url',
      'https://example.com/path',
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp custom scheme on iOS device uses active app context', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-openurl-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  try {
    await openIosApp(device, 'myapp://item/42', { appBundleId: 'com.example.app' });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'ios-device-1',
      'com.example.app',
      '--payload-url',
      'myapp://item/42',
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp captures iOS simulator launch console output when requested', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-console-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const launchConsolePath = path.join(tmpDir, 'console.log');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then',
      '  printf "console stdout"',
      '  echo "console stderr" >&2',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    mockEnsureBootedSimulator.mockResolvedValue();
    await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
      appBundleId: 'com.example.app',
      launchConsole: launchConsolePath,
    });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, ['simctl', 'launch', '--console-pty', 'sim-1', 'com.example.app']);
    assert.equal(await fs.readFile(launchConsolePath, 'utf8'), 'console stdout\nconsole stderr\n');
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp emits a clean simctl launch when launchArgs is an empty array', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-launch-args-empty-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    mockEnsureBootedSimulator.mockResolvedValue();
    await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
      appBundleId: 'com.example.app',
      launchArgs: [],
    });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, ['simctl', 'launch', 'sim-1', 'com.example.app']);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp appends launchArgs after the bundle id on iOS device', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-launch-args-dev-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await openIosApp(IOS_TEST_DEVICE, 'MyApp', {
      appBundleId: 'com.example.app',
      launchArgs: ['-FeatureFlag', 'YES'],
    });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
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
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp appends launchArgs alongside --payload-url for iOS device deep links', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-launch-args-deep-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await openIosApp(IOS_TEST_DEVICE, 'myapp://item/42', {
      appBundleId: 'com.example.app',
      launchArgs: ['-Tracking', 'NO'],
    });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
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
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
  await assert.rejects(
    () =>
      openIosApp(IOS_TEST_SIMULATOR, 'myapp://item/42', {
        launchArgs: ['-FeatureFlag', 'YES'],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.message), /simctl openurl/);
      return true;
    },
  );
});

test('openIosApp rejects launchArgs on macOS', async () => {
  await assert.rejects(
    () =>
      openIosApp(MACOS_TEST_DEVICE, 'TextEdit', {
        launchArgs: ['-FeatureFlag', 'YES'],
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.match(String(error.message), /macOS/);
      return true;
    },
  );
});

test('readIosClipboardText rejects physical devices', async () => {
  await assert.rejects(
    () => readIosClipboardText(IOS_TEST_DEVICE),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'UNSUPPORTED_OPERATION');
      return true;
    },
  );
});

test('closeIosApp on macOS uses helper quit for bundle identifiers', async () => {
  await withMockedMacOsHelper(
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"',
      "cat <<'JSON'",
      '{"ok":true,"data":{"bundleId":"com.example.foobar","running":true,"terminated":true,"forceTerminated":false}}',
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

test('reinstallIosApp on iOS physical device uses devicectl uninstall + install', async () => {
  await withMockedXcrun(
    'agent-device-ios-reinstall-device-test-',
    `#!/bin/sh
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "info" ] && [ "$4" = "apps" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--json-output" ]; then
      out="$2"
      shift 2
      continue
    fi
    shift
  done
  cat > "$out" <<'JSON'
{"result":{"apps":[{"bundleIdentifier":"com.example.demo","name":"Demo"}]}}
JSON
fi
exit 0
`,
    async ({ tmpDir, argsLogPath, device }) => {
      const appPath = path.join(tmpDir, 'Sample.app');
      await fs.mkdir(appPath, { recursive: true });
      const result = await reinstallIosApp(device, 'Demo', appPath);
      assert.equal(result.bundleId, 'com.example.demo');

      const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);

      const uninstallIdx = args.indexOf('uninstall');
      const installIdx = args.indexOf('install');
      assert.notEqual(uninstallIdx, -1);
      assert.notEqual(installIdx, -1);
      assert.equal(uninstallIdx < installIdx, true, 'reinstall should uninstall before install');
      assert.deepEqual(args.slice(uninstallIdx - 2, uninstallIdx + 5), [
        'devicectl',
        'device',
        'uninstall',
        'app',
        '--device',
        'ios-device-1',
        'com.example.demo',
      ]);
      assert.deepEqual(args.slice(installIdx - 2, installIdx + 5), [
        'devicectl',
        'device',
        'install',
        'app',
        '--device',
        'ios-device-1',
        appPath,
      ]);
    },
  );
});

test('reinstallIosApp on iOS physical device proceeds when uninstall reports app not installed', async () => {
  await withMockedXcrun(
    'agent-device-ios-reinstall-device-missing-app-test-',
    `#!/bin/sh
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "info" ] && [ "$4" = "apps" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--json-output" ]; then
      out="$2"
      shift 2
      continue
    fi
    shift
  done
  cat > "$out" <<'JSON'
{"result":{"apps":[{"bundleIdentifier":"com.example.demo","name":"Demo"}]}}
JSON
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "uninstall" ] && [ "$4" = "app" ]; then
  echo "app not installed" >&2
  exit 1
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "install" ] && [ "$4" = "app" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ tmpDir, argsLogPath, device }) => {
      const appPath = path.join(tmpDir, 'Sample.app');
      await fs.mkdir(appPath, { recursive: true });
      const result = await reinstallIosApp(device, 'Demo', appPath);
      assert.equal(result.bundleId, 'com.example.demo');

      const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.equal(args.includes('uninstall'), true);
      assert.equal(args.includes('install'), true);
    },
  );
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

test('installIosApp on iOS physical device accepts .ipa and installs extracted .app payload', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-install-ipa-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const unzipPath = path.join(tmpDir, 'unzip');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const ipaPath = path.join(tmpDir, 'Sample.ipa');
  await fs.writeFile(ipaPath, 'placeholder', 'utf8');

  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);
  await fs.writeFile(unzipPath, '#!/bin/sh\nmkdir -p "$4/Payload/Sample.app"\nexit 0\n', 'utf8');
  await fs.chmod(unzipPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await installIosApp(IOS_TEST_DEVICE, ipaPath);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    const installIdx = args.indexOf('install');
    assert.notEqual(installIdx, -1);
    assert.deepEqual(args.slice(installIdx - 2, installIdx + 4), [
      'devicectl',
      'device',
      'install',
      'app',
      '--device',
      'ios-device-1',
    ]);
    const installedPath = args[installIdx + 4];
    assert.equal(typeof installedPath, 'string');
    assert.equal(installedPath?.endsWith('/Payload/Sample.app'), true);
    assert.notEqual(installedPath, ipaPath);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installIosApp returns bundleId and launchTarget for nested archive sources', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-install-archive-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const unzipPath = path.join(tmpDir, 'unzip');
  const plutilPath = path.join(tmpDir, 'plutil');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const archivePath = path.join(tmpDir, 'Sample.zip');
  await fs.writeFile(archivePath, 'placeholder', 'utf8');

  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);
  await fs.writeFile(
    unzipPath,
    [
      '#!/bin/sh',
      'src="$2"',
      'out="$4"',
      'case "$src" in',
      '  *.zip)',
      '    mkdir -p "$out/Build"',
      '    printf "ipa" > "$out/Build/Sample.ipa"',
      '    exit 0',
      '    ;;',
      '  *.ipa)',
      '    mkdir -p "$out/Payload/Sample.app"',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(unzipPath, 0o755);
  await fs.writeFile(
    plutilPath,
    [
      '#!/bin/sh',
      'key="$2"',
      'last_arg=""',
      'for arg in "$@"; do',
      '  last_arg="$arg"',
      'done',
      'case "$key" in',
      '  CFBundleIdentifier) echo "com.example.archive"; exit 0 ;;',
      '  CFBundleDisplayName) echo "Archive App"; exit 0 ;;',
      '  CFBundleName) echo "Archive App"; exit 0 ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(plutilPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    const result = await installIosApp(IOS_TEST_DEVICE, archivePath);
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(result.archivePath, archivePath);
    assert.equal(result.bundleId, 'com.example.archive');
    assert.equal(result.appName, 'Archive App');
    assert.equal(result.launchTarget, 'com.example.archive');
    assert.equal(result.installablePath.endsWith('/Payload/Sample.app'), true);
    const installIdx = args.indexOf('install');
    assert.notEqual(installIdx, -1);
    assert.equal(args[installIdx + 4]?.endsWith('/Payload/Sample.app'), true);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installIosApp on iOS physical device resolves multi-app .ipa using bundle identifier hint', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-ios-install-ipa-multi-test-'),
  );
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const unzipPath = path.join(tmpDir, 'unzip');
  const plutilPath = path.join(tmpDir, 'plutil');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const ipaPath = path.join(tmpDir, 'Sample.ipa');
  await fs.writeFile(ipaPath, 'placeholder', 'utf8');

  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);
  await fs.writeFile(
    unzipPath,
    '#!/bin/sh\nmkdir -p "$4/Payload/Sample.app"\nmkdir -p "$4/Payload/Companion.app"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(unzipPath, 0o755);
  await fs.writeFile(
    plutilPath,
    [
      '#!/bin/sh',
      'last_arg=""',
      'for arg in "$@"; do',
      '  last_arg="$arg"',
      'done',
      'case "$last_arg" in',
      '  *"/Sample.app/"*) echo "com.example.sample"; exit 0 ;;',
      '  *"/Companion.app/"*) echo "com.example.companion"; exit 0 ;;',
      'esac',
      'echo "missing bundle id" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(plutilPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await installIosApp(IOS_TEST_DEVICE, ipaPath, { appIdentifierHint: 'com.example.sample' });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    const installIdx = args.indexOf('install');
    assert.notEqual(installIdx, -1);
    const installedPath = args[installIdx + 4];
    assert.equal(typeof installedPath, 'string');
    assert.equal(installedPath?.endsWith('/Payload/Sample.app'), true);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installIosApp rejects multi-app .ipa when no hint is provided', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-ios-install-ipa-multi-missing-hint-test-'),
  );
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const unzipPath = path.join(tmpDir, 'unzip');
  const plutilPath = path.join(tmpDir, 'plutil');
  const ipaPath = path.join(tmpDir, 'Sample.ipa');
  await fs.writeFile(ipaPath, 'placeholder', 'utf8');

  await fs.writeFile(xcrunPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(xcrunPath, 0o755);
  await fs.writeFile(
    unzipPath,
    '#!/bin/sh\nmkdir -p "$4/Payload/Sample.app"\nmkdir -p "$4/Payload/Companion.app"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(unzipPath, 0o755);
  await fs.writeFile(
    plutilPath,
    [
      '#!/bin/sh',
      'last_arg=""',
      'for arg in "$@"; do',
      '  last_arg="$arg"',
      'done',
      'case "$last_arg" in',
      '  *"/Sample.app/"*) echo "com.example.sample"; exit 0 ;;',
      '  *"/Companion.app/"*) echo "com.example.companion"; exit 0 ;;',
      'esac',
      'echo "missing bundle id" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(plutilPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  try {
    await assert.rejects(
      () => installIosApp(IOS_TEST_DEVICE, ipaPath),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /found 2 \.app bundles/i);
        assert.match((error as AppError).message, /pass an app identifier|bundle name/i);
        return true;
      },
    );
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installIosApp rejects invalid .ipa payloads without embedded .app', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-ios-install-ipa-invalid-test-'),
  );
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const unzipPath = path.join(tmpDir, 'unzip');
  const ipaPath = path.join(tmpDir, 'Broken.ipa');
  await fs.writeFile(ipaPath, 'placeholder', 'utf8');

  await fs.writeFile(xcrunPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(xcrunPath, 0o755);
  await fs.writeFile(unzipPath, '#!/bin/sh\nmkdir -p "$4/NoPayload"\nexit 0\n', 'utf8');
  await fs.chmod(unzipPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  try {
    await assert.rejects(
      () => installIosApp(IOS_TEST_DEVICE, ipaPath),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'INVALID_ARGS');
        assert.match((error as AppError).message, /invalid ipa/i);
        return true;
      },
    );
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('openIosApp with app and URL on iOS device launches app bundle with payload URL', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-open-app-url-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  try {
    await openIosApp(device, 'MyApp', { appBundleId: 'com.example.app', url: 'myapp://screen/to' });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(args, [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      'ios-device-1',
      'com.example.app',
      '--payload-url',
      'myapp://screen/to',
    ]);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('pushIosNotification uses simctl push with temporary payload file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-push-test-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const payloadCapturePath = path.join(tmpDir, 'payload.json');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then',
      '  echo \'{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}\'',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "push" ]; then',
      '  cat "$5" > "$AGENT_DEVICE_TEST_PAYLOAD_FILE"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousPayloadFile = process.env.AGENT_DEVICE_TEST_PAYLOAD_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_TEST_PAYLOAD_FILE = payloadCapturePath;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  };

  try {
    await pushIosNotification(device, 'com.example.app', { aps: { alert: 'hello', badge: 4 } });
    const args = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(args[0], 'simctl');
    assert.equal(args[1], 'push');
    assert.equal(args[2], 'sim-1');
    assert.equal(args[3], 'com.example.app');
    assert.match(args[4] ?? '', /payload\.apns$/);
    const payload = JSON.parse(await fs.readFile(payloadCapturePath, 'utf8')) as {
      aps: { alert: string; badge: number };
    };
    assert.deepEqual(payload, { aps: { alert: 'hello', badge: 4 } });
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    if (previousPayloadFile === undefined) delete process.env.AGENT_DEVICE_TEST_PAYLOAD_FILE;
    else process.env.AGENT_DEVICE_TEST_PAYLOAD_FILE = previousPayloadFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveIosApp resolves app display name on iOS physical devices', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-app-resolve-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "info" ] && [ "$4" = "apps" ]; then',
      '  out=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--json-output" ]; then',
      '      out="$2"',
      '      shift 2',
      '      continue',
      '    fi',
      '    shift',
      '  done',
      '  cat > "$out" <<\'JSON\'',
      '{"result":{"apps":[{"bundleIdentifier":"com.apple.Maps","name":"Maps"},{"bundleIdentifier":"com.example.demo","name":"Demo"}]}}',
      'JSON',
      '  exit 0',
      'fi',
      'echo "unexpected xcrun args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  };

  try {
    const bundleId = await resolveIosApp(device, 'Maps');
    assert.equal(bundleId, 'com.apple.Maps');
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveIosApp caches display-name bundle matches but bypasses exact bundle ids', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-resolve-cache-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "simctl" ] && [ "$2" = "listapps" ]; then',
      "  cat <<'JSON'",
      '{"com.example.cachemaps":{"CFBundleDisplayName":"Cache Maps"}}',
      'JSON',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-cache-1',
    name: 'iPhone Cache',
    kind: 'simulator',
    booted: true,
  };

  try {
    const first = await resolveIosApp(device, 'Cache Maps');
    const second = await resolveIosApp(device, 'Cache Maps');
    const exact = await resolveIosApp(device, 'com.example.cachemaps');

    assert.equal(first, 'com.example.cachemaps');
    assert.equal(second, 'com.example.cachemaps');
    assert.equal(exact, 'com.example.cachemaps');

    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.equal((logged.match(/simctl listapps/g) ?? []).length, 1);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveIosSimulatorDeepLinkBundleId maps custom URL scheme to installed user app', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-scheme-resolve-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const plutilPath = path.join(tmpDir, 'plutil');
  const appPath = path.join(tmpDir, 'ReactNavigationExample.app');
  const runnerPath = path.join(tmpDir, 'AgentDeviceRunner.app');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "simctl" ] && [ "$2" = "listapps" ]; then',
      "  cat <<'JSON'",
      JSON.stringify({
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
      }),
      'JSON',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    plutilPath,
    [
      '#!/bin/sh',
      'case "$5" in',
      [
        '  *AgentDeviceRunner.app/Info.plist) echo ',
        '\'{"CFBundleURLTypes":[{"CFBundleURLSchemes":["rne"]}]}\' ;;',
      ].join(''),
      [
        '  *ReactNavigationExample.app/Info.plist) echo ',
        '\'{"CFBundleURLTypes":[{"CFBundleURLSchemes":["rne"]}]}\' ;;',
      ].join(''),
      '  *) echo "{}" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);
  await fs.chmod(plutilPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;

  try {
    const bundleId = await resolveIosSimulatorDeepLinkBundleId(
      IOS_TEST_SIMULATOR,
      'rne://navigator-layout',
    );
    assert.equal(bundleId, 'org.reactnavigation.playground');
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installIosInstallablePath invalidates cached display-name bundle matches', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-install-cache-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const appPath = path.join(tmpDir, 'Cache.app');
  const markerPath = path.join(tmpDir, 'installed.marker');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "simctl" ] && [ "$2" = "listapps" ]; then',
      '  if [ -f "$AGENT_DEVICE_TEST_INSTALL_MARKER" ]; then',
      "    cat <<'JSON'",
      '{"com.example.installedcachemaps":{"CFBundleDisplayName":"Cache Maps"}}',
      'JSON',
      '  else',
      "    cat <<'JSON'",
      '{"com.example.cachemaps":{"CFBundleDisplayName":"Cache Maps"}}',
      'JSON',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "simctl" ] && [ "$2" = "install" ]; then',
      '  : > "$AGENT_DEVICE_TEST_INSTALL_MARKER"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(xcrunPath, 0o755);
  await fs.mkdir(appPath);

  const previousPath = process.env.PATH;
  const previousMarker = process.env.AGENT_DEVICE_TEST_INSTALL_MARKER;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_INSTALL_MARKER = markerPath;

  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-cache-install-1',
    name: 'iPhone Cache',
    kind: 'simulator',
    booted: true,
  };
  mockEnsureBootedSimulator.mockResolvedValue(undefined);

  try {
    const before = await resolveIosApp(device, 'Cache Maps');
    await installIosInstallablePath(device, appPath);
    const after = await resolveIosApp(device, 'Cache Maps');

    assert.equal(before, 'com.example.cachemaps');
    assert.equal(after, 'com.example.installedcachemaps');
  } finally {
    process.env.PATH = previousPath;
    if (previousMarker === undefined) {
      delete process.env.AGENT_DEVICE_TEST_INSTALL_MARKER;
    } else {
      process.env.AGENT_DEVICE_TEST_INSTALL_MARKER = previousMarker;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('setIosSetting faceid match uses simctl biometric match', async () => {
  await withMockedXcrun(
    'agent-device-ios-faceid-match-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "sim-1" ] && [ "$4" = "match" ] && [ "$5" = "face" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'faceid', 'match');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /simctl biometric sim-1 match face/);
    },
  );
});

test('setIosSetting faceid retries alternate biometric argument order', async () => {
  await withMockedXcrun(
    'agent-device-ios-faceid-fallback-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "sim-1" ] && [ "$4" = "match" ] && [ "$5" = "face" ]; then
  exit 2
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "match" ] && [ "$4" = "sim-1" ] && [ "$5" = "face" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'faceid', 'match');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /simctl biometric sim-1 match face/);
      assert.match(logged, /simctl biometric match sim-1 face/);
    },
  );
});

test('setIosSetting touchid match uses simctl biometric match finger', async () => {
  await withMockedXcrun(
    'agent-device-ios-touchid-match-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "sim-1" ] && [ "$4" = "match" ] && [ "$5" = "finger" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'touchid', 'match');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /simctl biometric sim-1 match finger/);
    },
  );
});

test('setIosSetting touchid retries touch modality when finger fails', async () => {
  await withMockedXcrun(
    'agent-device-ios-touchid-fallback-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "sim-1" ] && [ "$4" = "match" ] && [ "$5" = "finger" ]; then
  exit 2
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "match" ] && [ "$4" = "sim-1" ] && [ "$5" = "finger" ]; then
  exit 2
fi
if [ "$1" = "simctl" ] && [ "$2" = "biometric" ] && [ "$3" = "sim-1" ] && [ "$4" = "match" ] && [ "$5" = "touch" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'touchid', 'match');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /simctl biometric sim-1 match finger/);
      assert.match(logged, /simctl biometric match sim-1 finger/);
      assert.match(logged, /simctl biometric sim-1 match touch/);
    },
  );
});

test('setIosSetting touchid reports unsupported when simctl biometric is unavailable', async () => {
  await withMockedXcrun(
    'agent-device-ios-touchid-unsupported-test-',
    `#!/bin/sh
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
echo "unknown subcommand biometric" >&2
exit 1
`,
    async () => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await assert.rejects(
        () => setIosSetting(device, 'touchid', 'match'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'UNSUPPORTED_OPERATION');
          assert.match((error as AppError).message, /Touch ID simulation is not supported/);
          return true;
        },
      );
    },
  );
});

test('setIosSetting touchid keeps COMMAND_FAILED for operational failures', async () => {
  await withMockedXcrun(
    'agent-device-ios-touchid-command-failed-test-',
    `#!/bin/sh
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
echo "Failed to boot simulator service" >&2
exit 1
`,
    async () => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await assert.rejects(
        () => setIosSetting(device, 'touchid', 'match'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as AppError).message, /Failed to simulate touchid/);
          return true;
        },
      );
    },
  );
});

test('setIosSetting appearance toggle queries current osascript appearance on macOS', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-macos-appearance-toggle-test-'),
  );
  const osascriptPath = path.join(tmpDir, 'osascript');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    osascriptPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'case "$2" in',
      '  *"get dark mode"*)',
      '    echo "true"',
      '    exit 0',
      '    ;;',
      '  *"set dark mode to false"*)',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(osascriptPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await setIosSetting(MACOS_TEST_DEVICE, 'appearance', 'toggle');
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /get dark mode/);
    assert.match(logged, /set dark mode to false/);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
  await assert.rejects(
    () =>
      setIosSetting(MACOS_TEST_DEVICE, 'permission', 'deny', undefined, {
        permissionTarget: 'accessibility',
      }),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'INVALID_ARGS');
      assert.match((error as AppError).message, /Unsupported macOS setting: permission/i);
      return true;
    },
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
  await withMockedXcrun(
    'agent-device-ios-location-set-test-',
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath }) => {
      mockEnsureBootedSimulator.mockResolvedValue(undefined);
      await setIosSetting(IOS_TEST_SIMULATOR, 'location', 'set', undefined, {
        latitude: 37.3349,
        longitude: -122.009,
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nlocation\nsim-1\nset\n37\.3349,-122\.009/);
    },
  );
});

test('setIosSetting appearance toggle flips current simulator appearance', async () => {
  await withMockedXcrun(
    'agent-device-ios-appearance-toggle-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "ui" ] && [ "$3" = "sim-1" ] && [ "$4" = "appearance" ] && [ -z "$5" ]; then
  echo "dark"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "ui" ] && [ "$3" = "sim-1" ] && [ "$4" = "appearance" ] && [ "$5" = "light" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'appearance', 'toggle');
      const lines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      const logged = lines.join(' ');
      assert.match(logged, /simctl ui sim-1 appearance/);
      assert.match(logged, /simctl ui sim-1 appearance light/);
    },
  );
});

test('setIosSetting appearance toggle rejects unsupported current appearance output', async () => {
  await withMockedXcrun(
    'agent-device-ios-appearance-toggle-unsupported-test-',
    `#!/bin/sh
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "ui" ] && [ "$3" = "sim-1" ] && [ "$4" = "appearance" ] && [ -z "$5" ]; then
  echo "unsupported"
  exit 0
fi
exit 0
`,
    async () => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await assert.rejects(
        () => setIosSetting(device, 'appearance', 'toggle'),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'COMMAND_FAILED');
          assert.match((error as AppError).message, /Unable to determine current iOS appearance/);
          return true;
        },
      );
    },
  );
});

test('setIosSetting permission grant calendar uses simctl privacy calendar target', async () => {
  await withMockedXcrun(
    'agent-device-ios-permission-calendar-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "sim-1" ] && [ "$4" = "grant" ] && [ "$5" = "calendar" ] && [ "$6" = "com.example.app" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'calendar',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nprivacy\nsim-1\ngrant\ncalendar\ncom\.example\.app/);
    },
  );
});

test('setIosSetting clear-app-state wipes iOS simulator app data container', async () => {
  await withMockedXcrun(
    'agent-device-ios-clear-app-state-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "terminate" ] && [ "$3" = "sim-1" ] && [ "$4" = "com.example.app" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ] && [ "$3" = "sim-1" ] && [ "$4" = "com.example.app" ] && [ "$5" = "data" ]; then
  echo "$AGENT_DEVICE_TEST_CONTAINER"
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ tmpDir, argsLogPath }) => {
      const containerPath = path.join(tmpDir, 'container');
      await fs.mkdir(path.join(containerPath, 'Documents'), { recursive: true });
      await fs.writeFile(path.join(containerPath, 'Documents', 'db.sqlite'), 'db');
      await fs.writeFile(path.join(containerPath, 'Library.plist'), 'prefs');
      const previousContainer = process.env.AGENT_DEVICE_TEST_CONTAINER;
      process.env.AGENT_DEVICE_TEST_CONTAINER = containerPath;
      try {
        const result = await setIosSetting(
          IOS_TEST_SIMULATOR,
          'clear-app-state',
          'clear',
          'com.example.app',
        );
        assert.equal(result?.cleared, true);
        assert.equal(result?.bundleId, 'com.example.app');
        assert.deepEqual(await fs.readdir(containerPath), []);
      } finally {
        if (previousContainer === undefined) delete process.env.AGENT_DEVICE_TEST_CONTAINER;
        else process.env.AGENT_DEVICE_TEST_CONTAINER = previousContainer;
      }
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nterminate\nsim-1\ncom\.example\.app/);
      assert.match(logged, /simctl\nget_app_container\nsim-1\ncom\.example\.app\ndata/);
    },
  );
});

test('setIosSetting permission grant photos limited maps to photos-add', async () => {
  await withMockedXcrun(
    'agent-device-ios-permission-photos-test-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "sim-1" ] && [ "$4" = "grant" ] && [ "$5" = "photos-add" ] && [ "$6" = "com.example.app" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'permission', 'grant', 'com.example.app', {
        permissionTarget: 'photos',
        permissionMode: 'limited',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nprivacy\nsim-1\ngrant\nphotos-add\ncom\.example\.app/);
    },
  );
});

test('setIosSetting permission rejects mode for non-photos target', async () => {
  await withMockedXcrun(
    'agent-device-ios-permission-mode-validation-test-',
    `#!/bin/sh
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async () => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await assert.rejects(
        () =>
          setIosSetting(device, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'camera',
            permissionMode: 'limited',
          }),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'INVALID_ARGS');
          assert.match((error as AppError).message, /mode is only supported for photos/i);
          return true;
        },
      );
    },
  );
});

test('setIosSetting permission reset notifications falls back to reset all when direct reset is blocked', async () => {
  await withMockedXcrun(
    'agent-device-ios-permission-notifications-reset-fallback-',
    `#!/bin/sh
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "sim-1" ] && [ "$4" = "reset" ] && [ "$5" = "notifications" ] && [ "$6" = "com.example.app" ]; then
  echo "Failed to reset access" >&2
  echo "Operation not permitted" >&2
  exit 1
fi
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "sim-1" ] && [ "$4" = "reset" ] && [ "$5" = "all" ] && [ "$6" = "com.example.app" ]; then
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await setIosSetting(device, 'permission', 'reset', 'com.example.app', {
        permissionTarget: 'notifications',
      });
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nprivacy\nsim-1\nreset\nnotifications\ncom\.example\.app/);
      assert.match(logged, /simctl\nprivacy\nsim-1\nreset\nall\ncom\.example\.app/);
    },
  );
});

test('setIosSetting permission deny notifications returns unsupported on runtimes that block it', async () => {
  await withMockedXcrun(
    'agent-device-ios-permission-notifications-deny-unsupported-',
    `#!/bin/sh
# AGENT_DEVICE_CUSTOM_PRIVACY_HELP
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "help" ]; then
  cat <<'HELP'
Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

        service
             The service:
                 notifications - Allow access to notifications.
                 camera - Allow access to camera.
HELP
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "sim-1" ] && [ "$4" = "revoke" ] && [ "$5" = "notifications" ] && [ "$6" = "com.example.app" ]; then
  echo "Failed to revoke access" >&2
  echo "Operation not permitted" >&2
  exit 1
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await assert.rejects(
        () =>
          setIosSetting(device, 'permission', 'deny', 'com.example.app', {
            permissionTarget: 'notifications',
          }),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'UNSUPPORTED_OPERATION');
          assert.match(
            (error as AppError).message,
            /does not support setting notifications permission/i,
          );
          return true;
        },
      );
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nprivacy\nsim-1\nrevoke\nnotifications\ncom\.example\.app/);
    },
  );
});

test('setIosSetting permission rejects service missing from simctl privacy help', async () => {
  await withMockedXcrun(
    'agent-device-ios-permission-service-unsupported-',
    `#!/bin/sh
# AGENT_DEVICE_CUSTOM_PRIVACY_HELP
printf "__CMD__\\n" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
printf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "help" ]; then
  cat <<'HELP'
Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

        service
             The service:
                 camera - Allow access to camera.
                 microphone - Allow access to audio input.
HELP
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "list" ] && [ "$3" = "devices" ] && [ "$4" = "-j" ]; then
  cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"udid":"sim-1","state":"Booted"}]}}
JSON
  exit 0
fi
echo "unexpected xcrun args: $@" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const device: DeviceInfo = {
        platform: 'apple',
        id: 'sim-1',
        name: 'iPhone Sim',
        kind: 'simulator',
        booted: true,
      };
      await assert.rejects(
        () =>
          setIosSetting(device, 'permission', 'grant', 'com.example.app', {
            permissionTarget: 'calendar',
          }),
        (error: unknown) => {
          assert.equal(error instanceof AppError, true);
          assert.equal((error as AppError).code, 'UNSUPPORTED_OPERATION');
          assert.match((error as AppError).message, /does not support service "calendar"/i);
          return true;
        },
      );
      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.match(logged, /simctl\nprivacy\nhelp/);
      assert.doesNotMatch(logged, /simctl\nprivacy\nsim-1\ngrant\ncalendar/);
    },
  );
});
