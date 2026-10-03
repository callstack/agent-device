import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

export const LEGACY_PREFS_PATH = 'shared_prefs/ReactNativeDevPrefs.xml';

export function defaultPrefsPath(packageName: string): string {
  return `shared_prefs/${packageName}_preferences.xml`;
}

function prefsKey(prefsPath: string): string {
  return prefsPath.replaceAll('/', '_');
}

export async function withMockedAdb(
  run: (ctx: {
    device: DeviceInfo;
    argsLogPath: string;
    seedPrefsFile: (prefsPath: string, xml: string) => Promise<void>;
    readWrittenPrefsFile: (prefsPath: string) => Promise<string | undefined>;
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtempForTest('agent-device-runtime-hints-android-');
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const seedDir = path.join(tmpDir, 'seed');
  const stdinDir = path.join(tmpDir, 'stdin');
  await fs.mkdir(seedDir, { recursive: true });
  await fs.mkdir(stdinDir, { recursive: true });
  await fs.writeFile(
    adbPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      String.raw`printf "%s\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"`,
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "cat" ]; then',
      '  key=$(printf "%s" "$5" | tr "/" "_")',
      '  if [ -f "$AGENT_DEVICE_TEST_SEED_DIR/$key" ]; then',
      '    cat "$AGENT_DEVICE_TEST_SEED_DIR/$key"',
      '    exit 0',
      '  fi',
      '  exit 1',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "id" ]; then',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT"',
      '  else',
      String.raw`    printf "%s\n" "uid=10162(u0_a162) gid=10162(u0_a162) groups=10162(u0_a162)"`,
      '  fi',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_ID_STDERR" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_ID_STDERR" >&2',
      '  fi',
      '  exit "${AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE:-0}"',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "mkdir" ] && [ "$5" = "-p" ] && [ "$6" = "shared_prefs" ]; then',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDOUT" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDOUT"',
      '  fi',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDERR" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDERR" >&2',
      '  fi',
      '  exit "${AGENT_DEVICE_TEST_RUN_AS_MKDIR_EXIT_CODE:-0}"',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "tee" ]; then',
      '  key=$(printf "%s" "$5" | tr "/" "_")',
      '  cat > "$AGENT_DEVICE_TEST_STDIN_DIR/$key"',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_WRITE_STDOUT" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_WRITE_STDOUT"',
      '  fi',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR" >&2',
      '  fi',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE" ] && [ "$AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE" != "0" ]; then',
      '    exit "$AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE"',
      '  fi',
      '  exit 0',
      'fi',
      'echo "unexpected args: $@" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousEnv = Object.fromEntries(
    [
      'AGENT_DEVICE_TEST_ARGS_FILE',
      'AGENT_DEVICE_TEST_SEED_DIR',
      'AGENT_DEVICE_TEST_STDIN_DIR',
      'AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE',
      'AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT',
      'AGENT_DEVICE_TEST_RUN_AS_ID_STDERR',
      'AGENT_DEVICE_TEST_RUN_AS_MKDIR_EXIT_CODE',
      'AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDOUT',
      'AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDERR',
      'AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE',
      'AGENT_DEVICE_TEST_RUN_AS_WRITE_STDOUT',
      'AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR',
    ].map((key) => [key, process.env[key]]),
  );
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_TEST_SEED_DIR = seedDir;
  process.env.AGENT_DEVICE_TEST_STDIN_DIR = stdinDir;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };
  const seedPrefsFile = async (prefsPath: string, xml: string): Promise<void> => {
    await fs.writeFile(path.join(seedDir, prefsKey(prefsPath)), xml, 'utf8');
  };
  const readWrittenPrefsFile = async (prefsPath: string): Promise<string | undefined> => {
    try {
      return await fs.readFile(path.join(stdinDir, prefsKey(prefsPath)), 'utf8');
    } catch {
      return undefined;
    }
  };

  try {
    await run({ device, argsLogPath, seedPrefsFile, readWrittenPrefsFile });
  } finally {
    process.env.PATH = previousPath;
    for (const [key, value] of Object.entries(previousEnv)) restoreEnv(key, value);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function withMockedXcrun(
  run: (ctx: { device: DeviceInfo; argsLogPath: string }) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtempForTest('agent-device-runtime-hints-ios-');
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    [
      '#!/bin/sh',
      String.raw`printf "%s\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"`,
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
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };

  try {
    await run({ device, argsLogPath });
  } finally {
    process.env.PATH = previousPath;
    restoreEnv('AGENT_DEVICE_TEST_ARGS_FILE', previousArgsFile);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
