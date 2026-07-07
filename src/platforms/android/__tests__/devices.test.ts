import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmdDetached: vi.fn(actual.runCmdDetached) };
});

const execActual =
  await vi.importActual<typeof import('../../../utils/exec.ts')>('../../../utils/exec.ts');

import { AppError } from '../../../kernel/errors.ts';
import { runCmdDetached, withCommandExecutorOverride } from '../../../utils/exec.ts';
import type { CommandExecutorOverride, ExecResult } from '../../../utils/exec.ts';
import {
  ensureAndroidEmulatorBooted,
  listAndroidDevices,
  parseAndroidAvdList,
  parseAndroidEmulatorAvdNameOutput,
  parseAndroidFeatureListForTv,
  parseAndroidTargetFromCharacteristics,
  resolveAndroidAvdName,
  resolveAndroidEmulatorAvdName,
} from '../devices.ts';

const mockRunCmdDetached = vi.mocked(runCmdDetached);

const MOCK_ANDROID_ADB_SCRIPT = [
  '#!/bin/sh',
  'if [ "$1" = "devices" ] && [ "$2" = "-l" ]; then',
  '  echo "List of devices attached"',
  '  if [ -f "$AGENT_DEVICE_TEST_EMU_BOOTED_FILE" ]; then',
  '    echo "emulator-5554 device product:sdk_gphone64 model:Pixel_9_Pro_XL device:emu64a transport_id:2"',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "emu" ] && [ "$4" = "avd" ] && [ "$5" = "name" ]; then',
  '  if [ "$AGENT_DEVICE_TEST_AVD_NAME_MODE" = "missing" ]; then',
  '    exit 0',
  '  fi',
  '  echo "Pixel_9_Pro_XL"',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ] && [ "$5" = "ro.boot.qemu.avd_name" ]; then',
  '  if [ "$AGENT_DEVICE_TEST_AVD_NAME_MODE" = "missing" ]; then',
  '    exit 0',
  '  fi',
  '  echo "Pixel_9_Pro_XL"',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ] && [ "$5" = "persist.sys.avd_name" ]; then',
  '  if [ "$AGENT_DEVICE_TEST_AVD_NAME_MODE" = "missing" ]; then',
  '    exit 0',
  '  fi',
  '  echo "Pixel_9_Pro_XL"',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ] && [ "$5" = "sys.boot_completed" ]; then',
  '  if [ -f "$AGENT_DEVICE_TEST_EMU_BOOTED_FILE" ]; then',
  '    echo "1"',
  '  else',
  '    echo "0"',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ] && [ "$5" = "ro.build.characteristics" ]; then',
  '  echo "phone"',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "shell" ] && [ "$4" = "cmd" ] && [ "$5" = "package" ] && [ "$6" = "has-feature" ]; then',
  '  echo "false"',
  '  exit 0',
  'fi',
  'if [ "$1" = "-s" ] && [ "$2" = "emulator-5554" ] && [ "$3" = "shell" ] && [ "$4" = "pm" ] && [ "$5" = "list" ] && [ "$6" = "features" ]; then',
  '  echo ""',
  '  exit 0',
  'fi',
  'echo "unexpected adb args: $@" >> "$AGENT_DEVICE_TEST_EMU_LOG_FILE"',
  'exit 1',
  '',
];

const MOCK_ANDROID_EMULATOR_SCRIPT = [
  '#!/bin/sh',
  'if [ "$1" = "-list-avds" ]; then',
  '  echo "Pixel_9_Pro_XL"',
  '  exit 0',
  'fi',
  'if [ "$1" = "-avd" ]; then',
  '  echo "$@" >> "$AGENT_DEVICE_TEST_EMU_LOG_FILE"',
  '  touch "$AGENT_DEVICE_TEST_EMU_BOOTED_FILE"',
  '  exit 0',
  'fi',
  'echo "unexpected emulator args: $@" >> "$AGENT_DEVICE_TEST_EMU_LOG_FILE"',
  'exit 1',
  '',
];

beforeEach(() => {
  mockRunCmdDetached.mockReset();
  mockRunCmdDetached.mockImplementation(execActual.runCmdDetached);
});

async function writeExecutable(filePath: string, lines: readonly string[]): Promise<void> {
  await fs.writeFile(filePath, lines.join('\n'), 'utf8');
  await fs.chmod(filePath, 0o755);
}

function mockDetachedEmulatorLaunch(emulatorLogPath: string, emulatorBootedPath: string): void {
  mockRunCmdDetached.mockImplementation((cmd, args, options) => {
    if (cmd === 'emulator' && args[0] === '-avd') {
      appendFileSync(emulatorLogPath, `${args.join(' ')}\n`, 'utf8');
      writeFileSync(emulatorBootedPath, 'ready', 'utf8');
      return 1234;
    }
    return execActual.runCmdDetached(cmd, args, options);
  });
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parseAndroidTargetFromCharacteristics detects tv markers', () => {
  assert.equal(parseAndroidTargetFromCharacteristics('tv,nosdcard'), 'tv');
  assert.equal(parseAndroidTargetFromCharacteristics('watch,leanback'), 'tv');
  assert.equal(parseAndroidTargetFromCharacteristics('phone,tablet'), null);
});

test('parseAndroidFeatureListForTv detects television and leanback features', () => {
  const tvFeatures = [
    'feature:android.software.leanback',
    'feature:android.hardware.type.television',
  ].join('\n');
  assert.equal(parseAndroidFeatureListForTv(tvFeatures), true);
  assert.equal(parseAndroidFeatureListForTv('feature:android.hardware.camera'), false);
});

test('parseAndroidAvdList drops empty lines', () => {
  const listed = parseAndroidAvdList('\nPixel_9_Pro_XL\n\nWear_OS\n');
  assert.deepEqual(listed, ['Pixel_9_Pro_XL', 'Wear_OS']);
});

test('parseAndroidEmulatorAvdNameOutput drops trailing adb protocol status', () => {
  assert.equal(parseAndroidEmulatorAvdNameOutput('Pixel_9_Pro_XL\r\nOK\r\n'), 'Pixel_9_Pro_XL');
  assert.equal(parseAndroidEmulatorAvdNameOutput('Pixel_9_Pro_XL\n'), 'Pixel_9_Pro_XL');
  assert.equal(parseAndroidEmulatorAvdNameOutput('\r\nOK\r\n'), undefined);
});

test('resolveAndroidAvdName supports space vs underscore matching', () => {
  const avdNames = ['Pixel_9_Pro_XL', 'Medium_Tablet_API_35'];
  assert.equal(resolveAndroidAvdName(avdNames, 'Pixel_9_Pro_XL'), 'Pixel_9_Pro_XL');
  assert.equal(resolveAndroidAvdName(avdNames, 'pixel 9 pro xl'), 'Pixel_9_Pro_XL');
  assert.equal(resolveAndroidAvdName(avdNames, 'unknown'), undefined);
});

async function withMockedAndroidTools(
  run: (ctx: { emulatorLogPath: string; emulatorBootedPath: string }) => Promise<void>,
  options: { avdNameMode?: 'success' | 'missing' } = {},
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-headless-'));
  const emulatorLogPath = path.join(tmpDir, 'emulator.log');
  const emulatorBootedPath = path.join(tmpDir, 'emulator.booted');
  const adbPath = path.join(tmpDir, 'adb');
  const emulatorPath = path.join(tmpDir, 'emulator');

  await writeExecutable(adbPath, MOCK_ANDROID_ADB_SCRIPT);
  await writeExecutable(emulatorPath, MOCK_ANDROID_EMULATOR_SCRIPT);

  try {
    mockDetachedEmulatorLaunch(emulatorLogPath, emulatorBootedPath);
    await withEnv(
      {
        PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_DEVICE_TEST_EMU_BOOTED_FILE: emulatorBootedPath,
        AGENT_DEVICE_TEST_EMU_LOG_FILE: emulatorLogPath,
        AGENT_DEVICE_TEST_AVD_NAME_MODE: options.avdNameMode ?? 'success',
        HOME: tmpDir,
        ANDROID_SDK_ROOT: undefined,
        ANDROID_HOME: undefined,
      },
      async () =>
        await withCommandExecutorOverride(
          createMockedAndroidToolsCommandOverride({
            emulatorBootedPath,
            avdNameMode: options.avdNameMode ?? 'success',
          }),
          async () => await run({ emulatorLogPath, emulatorBootedPath }),
        ),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function withMockedAndroidSdkRoot(
  run: (ctx: {
    emulatorLogPath: string;
    emulatorBootedPath: string;
    sdkRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-sdk-root-'));
  const sdkRoot = path.join(tmpDir, 'Android', 'Sdk');
  const platformToolsDir = path.join(sdkRoot, 'platform-tools');
  const emulatorDir = path.join(sdkRoot, 'emulator');
  const emulatorLogPath = path.join(tmpDir, 'emulator.log');
  const emulatorBootedPath = path.join(tmpDir, 'emulator.booted');
  const adbPath = path.join(platformToolsDir, 'adb');
  const emulatorPath = path.join(emulatorDir, 'emulator');

  await fs.mkdir(platformToolsDir, { recursive: true });
  await fs.mkdir(emulatorDir, { recursive: true });

  await writeExecutable(adbPath, MOCK_ANDROID_ADB_SCRIPT);
  await writeExecutable(emulatorPath, MOCK_ANDROID_EMULATOR_SCRIPT);

  try {
    mockDetachedEmulatorLaunch(emulatorLogPath, emulatorBootedPath);
    await withEnv(
      {
        PATH: process.env.PATH ?? '',
        AGENT_DEVICE_TEST_EMU_BOOTED_FILE: emulatorBootedPath,
        AGENT_DEVICE_TEST_EMU_LOG_FILE: emulatorLogPath,
        ANDROID_SDK_ROOT: sdkRoot,
        ANDROID_HOME: undefined,
      },
      async () =>
        await withCommandExecutorOverride(
          createMockedAndroidToolsCommandOverride({ emulatorBootedPath }),
          async () => await run({ emulatorLogPath, emulatorBootedPath, sdkRoot }),
        ),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function createMockedAndroidToolsCommandOverride(params: {
  emulatorBootedPath: string;
  avdNameMode?: 'success' | 'missing';
}): CommandExecutorOverride {
  return async (cmd, args) => {
    if (cmd === 'emulator') return handleMockedEmulatorCommand(args);
    if (cmd === 'adb') return handleMockedAdbCommand(args, params);
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

function handleMockedEmulatorCommand(args: string[]): ExecResult {
  const emulatorKey = args.join('\0');
  if (emulatorKey === '-list-avds') return execResult('Pixel_9_Pro_XL\n');
  throw new Error(`Unexpected emulator args: ${args.join(' ')}`);
}

function handleMockedAdbCommand(
  args: string[],
  params: { emulatorBootedPath: string; avdNameMode?: 'success' | 'missing' },
): ExecResult {
  const adbArgs = stripAdbSerial(args);
  const adbKey = adbArgs.join('\0');
  if (adbKey === 'devices\0-l') return mockedAdbDevicesResult(params.emulatorBootedPath);
  if (isAdbAvdNameProbe(adbKey)) {
    return execResult(params.avdNameMode === 'missing' ? '' : 'Pixel_9_Pro_XL\n');
  }
  if (adbKey === 'shell\0getprop\0sys.boot_completed') {
    return execResult(existsSync(params.emulatorBootedPath) ? '1\n' : '0\n');
  }
  if (adbKey === 'shell\0getprop\0ro.build.characteristics') return execResult('phone\n');
  if (isAdbPackageProbe(adbArgs)) return execResult('false\n');
  if (adbKey === 'shell\0pm\0list\0features') return execResult('\n');
  throw new Error(`Unexpected adb args: ${args.join(' ')}`);
}

function mockedAdbDevicesResult(emulatorBootedPath: string): ExecResult {
  const bootedDevice = existsSync(emulatorBootedPath)
    ? [
        'emulator-5554 device product:sdk_gphone64 model:Pixel_9_Pro_XL device:emu64a transport_id:2',
      ]
    : [];
  return execResult(['List of devices attached', ...bootedDevice, ''].join('\n'));
}

function isAdbAvdNameProbe(adbKey: string): boolean {
  return (
    adbKey === 'emu\0avd\0name' ||
    adbKey === 'shell\0getprop\0ro.boot.qemu.avd_name' ||
    adbKey === 'shell\0getprop\0persist.sys.avd_name'
  );
}

function isAdbPackageProbe(adbArgs: string[]): boolean {
  return adbArgs[0] === 'shell' && adbArgs[1] === 'cmd' && adbArgs[2] === 'package';
}

function stripAdbSerial(args: string[]): string[] {
  if (args[0] === '-s') return args.slice(2);
  return args;
}

function execResult(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode };
}

test('resolveAndroidEmulatorAvdName ignores probe timeouts and keeps probing', async () => {
  const calls: string[][] = [];
  const results = [
    new AppError('COMMAND_FAILED', 'adb timed out after 1500ms', { timeoutMs: 1500 }),
    { stdout: '', stderr: '', exitCode: 0 },
    { stdout: 'Pixel_9_Pro_XL\n', stderr: '', exitCode: 0 },
  ];
  const runAdb = async (
    _cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    calls.push(args);
    const next = results.shift();
    if (next instanceof AppError) throw next;
    assert.ok(next);
    return next;
  };

  const avdName = await resolveAndroidEmulatorAvdName('emulator-5554', runAdb);

  assert.equal(avdName, 'Pixel_9_Pro_XL');
  assert.deepEqual(
    calls.map((args) => args.slice(2)),
    [
      ['shell', 'getprop', 'ro.boot.qemu.avd_name'],
      ['shell', 'getprop', 'persist.sys.avd_name'],
      ['emu', 'avd', 'name'],
    ],
  );
});

test('resolveAndroidEmulatorAvdName rethrows non-timeout probe failures', async () => {
  const failure = new AppError('COMMAND_FAILED', 'adb exited with code 1', {
    stderr: 'device offline',
    exitCode: 1,
    processExitError: true,
  });
  let callCount = 0;
  const runAdb = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    callCount += 1;
    throw failure;
  };

  await assert.rejects(
    async () => await resolveAndroidEmulatorAvdName('emulator-5554', runAdb),
    (error) => error === failure,
  );
  assert.equal(callCount, 1);
});

test('listAndroidDevices falls back to model when emulator avd name is unavailable', async () => {
  await withMockedAndroidTools(
    async ({ emulatorBootedPath }) => {
      await fs.writeFile(emulatorBootedPath, 'ready', 'utf8');

      const devices = await listAndroidDevices();

      assert.equal(devices.length, 1);
      assert.equal(devices[0]?.id, 'emulator-5554');
      assert.equal(devices[0]?.name, 'Pixel 9 Pro XL');
      assert.equal(devices[0]?.kind, 'emulator');
    },
    { avdNameMode: 'missing' },
  );
});

test('listAndroidDevices includes stopped AVDs as non-booted emulators', async () => {
  await withMockedAndroidTools(async () => {
    const devices = await listAndroidDevices();

    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.id, 'Pixel_9_Pro_XL');
    assert.equal(devices[0]?.name, 'Pixel_9_Pro_XL');
    assert.equal(devices[0]?.kind, 'emulator');
    assert.equal(devices[0]?.booted, false);
  });
});

test('ensureAndroidEmulatorBooted launches emulator in headless mode when requested', async () => {
  await withMockedAndroidTools(async ({ emulatorLogPath, emulatorBootedPath }) => {
    const device = await ensureAndroidEmulatorBooted({
      avdName: 'Pixel 9 Pro XL',
      timeoutMs: 5_000,
      headless: true,
    });
    assert.equal(device.platform, 'android');
    assert.equal(device.kind, 'emulator');
    assert.equal(device.id, 'emulator-5554');
    assert.equal(device.booted, true);
    const log = await fs.readFile(emulatorLogPath, 'utf8');
    assert.match(log, /-avd Pixel_9_Pro_XL -no-window -no-audio/);
    await fs.access(emulatorBootedPath);
  });
}, 10_000);

test('ensureAndroidEmulatorBooted reuses running emulator for headless requests', async () => {
  await withMockedAndroidTools(async ({ emulatorLogPath, emulatorBootedPath }) => {
    await fs.writeFile(emulatorBootedPath, 'ready', 'utf8');
    const device = await ensureAndroidEmulatorBooted({
      avdName: 'Pixel_9_Pro_XL',
      timeoutMs: 5_000,
      headless: true,
    });
    assert.equal(device.id, 'emulator-5554');
    const log = await fs.readFile(emulatorLogPath, 'utf8').catch(() => '');
    assert.equal(log.trim(), '');
  });
}, 10_000);

test('ensureAndroidEmulatorBooted launches emulator with GUI by default', async () => {
  await withMockedAndroidTools(async ({ emulatorLogPath }) => {
    const device = await ensureAndroidEmulatorBooted({
      avdName: 'Pixel_9_Pro_XL',
      timeoutMs: 5_000,
    });
    assert.equal(device.id, 'emulator-5554');
    const log = await fs.readFile(emulatorLogPath, 'utf8');
    assert.match(log, /-avd Pixel_9_Pro_XL/);
    assert.doesNotMatch(log, /-no-window/);
  });
}, 10_000);

test('ensureAndroidEmulatorBooted falls back to ANDROID_SDK_ROOT when PATH is incomplete', async () => {
  await withMockedAndroidSdkRoot(async ({ emulatorLogPath, sdkRoot }) => {
    const device = await ensureAndroidEmulatorBooted({
      avdName: 'Pixel 9 Pro XL',
      timeoutMs: 5_000,
      headless: true,
    });
    assert.equal(device.id, 'emulator-5554');
    const log = await fs.readFile(emulatorLogPath, 'utf8');
    assert.match(log, /-avd Pixel_9_Pro_XL -no-window -no-audio/);
    assert.ok((process.env.PATH ?? '').includes(path.join(sdkRoot, 'platform-tools')));
    assert.ok((process.env.PATH ?? '').includes(path.join(sdkRoot, 'emulator')));
    assert.equal(process.env.ANDROID_HOME, sdkRoot);
  });
}, 10_000);
