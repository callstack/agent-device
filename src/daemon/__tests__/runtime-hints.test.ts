import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import { applyRuntimeHintsToApp, clearRuntimeHintsFromApp } from '../runtime-hints.ts';
import { resolveRuntimeTransportHints } from '../../utils/runtime-transport.ts';
import type { DeviceInfo } from '../../kernel/device.ts';

async function withMockedAdb(
  run: (ctx: {
    device: DeviceInfo;
    argsLogPath: string;
    readFilePath: string;
    stdinFilePath: string;
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-runtime-hints-android-'));
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const readFilePath = path.join(tmpDir, 'existing.xml');
  const stdinFilePath = path.join(tmpDir, 'write-stdin.xml');
  await fs.writeFile(
    adbPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "cat" ]; then',
      '  if [ -f "$AGENT_DEVICE_TEST_READ_FILE" ]; then',
      '    cat "$AGENT_DEVICE_TEST_READ_FILE"',
      '    exit 0',
      '  fi',
      '  exit 1',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "id" ]; then',
      '  if [ -n "$AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT" ]; then',
      '    printf "%s" "$AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT"',
      '  else',
      '    printf "%s\\n" "uid=10162(u0_a162) gid=10162(u0_a162) groups=10162(u0_a162)"',
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
      'if [ "$1" = "shell" ] && [ "$2" = "run-as" ] && [ "$4" = "tee" ] && [ "$5" = "shared_prefs/ReactNativeDevPrefs.xml" ]; then',
      '  cat > "$AGENT_DEVICE_TEST_STDIN_FILE"',
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
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousReadFile = process.env.AGENT_DEVICE_TEST_READ_FILE;
  const previousStdinFile = process.env.AGENT_DEVICE_TEST_STDIN_FILE;
  const previousRunAsIdExitCode = process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE;
  const previousRunAsIdStdout = process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT;
  const previousRunAsIdStderr = process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR;
  const previousRunAsMkdirExitCode = process.env.AGENT_DEVICE_TEST_RUN_AS_MKDIR_EXIT_CODE;
  const previousRunAsMkdirStdout = process.env.AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDOUT;
  const previousRunAsMkdirStderr = process.env.AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDERR;
  const previousRunAsWriteExitCode = process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE;
  const previousRunAsWriteStdout = process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_STDOUT;
  const previousRunAsWriteStderr = process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  process.env.AGENT_DEVICE_TEST_READ_FILE = readFilePath;
  process.env.AGENT_DEVICE_TEST_STDIN_FILE = stdinFilePath;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await run({ device, argsLogPath, readFilePath, stdinFilePath });
  } finally {
    process.env.PATH = previousPath;
    restoreEnv('AGENT_DEVICE_TEST_ARGS_FILE', previousArgsFile);
    restoreEnv('AGENT_DEVICE_TEST_READ_FILE', previousReadFile);
    restoreEnv('AGENT_DEVICE_TEST_STDIN_FILE', previousStdinFile);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE', previousRunAsIdExitCode);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_ID_STDOUT', previousRunAsIdStdout);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_ID_STDERR', previousRunAsIdStderr);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_MKDIR_EXIT_CODE', previousRunAsMkdirExitCode);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDOUT', previousRunAsMkdirStdout);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_MKDIR_STDERR', previousRunAsMkdirStderr);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE', previousRunAsWriteExitCode);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_WRITE_STDOUT', previousRunAsWriteStdout);
    restoreEnv('AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR', previousRunAsWriteStderr);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function withMockedXcrun(
  run: (ctx: { device: DeviceInfo; argsLogPath: string }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-runtime-hints-ios-'));
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  await fs.writeFile(
    xcrunPath,
    ['#!/bin/sh', 'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"', 'exit 0', ''].join('\n'),
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
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function assertInvalidArgsAppError(error: unknown, message: string): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'INVALID_ARGS');
  assert.equal(error.message, message);
  return true;
}

test('resolveRuntimeTransportHints derives host, port, and scheme from bundle URL', () => {
  assert.deepEqual(
    resolveRuntimeTransportHints({
      platform: 'android',
      bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
    }),
    {
      host: '10.0.0.10',
      port: 8082,
      scheme: 'https',
    },
  );
});

test('applyRuntimeHintsToApp writes React Native Android dev prefs', async () => {
  await withMockedAdb(async ({ device, argsLogPath, readFilePath, stdinFilePath }) => {
    await fs.writeFile(
      readFilePath,
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        '  <string name="keep">value</string>',
        '</map>',
        '',
      ].join('\n'),
      'utf8',
    );

    await applyRuntimeHintsToApp({
      device,
      appId: 'com.example.demo',
      runtime: {
        platform: 'android',
        bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    const stdinPayload = await fs.readFile(stdinFilePath, 'utf8');
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/ReactNativeDevPrefs\.xml/,
    );
    assert.match(loggedArgs, /shell run-as com\.example\.demo mkdir -p shared_prefs/);
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/ReactNativeDevPrefs\.xml/,
    );
    assert.match(stdinPayload, /<string name="keep">value<\/string>/);
    assert.match(stdinPayload, /<string name="debug_http_host">10\.0\.0\.10:8082<\/string>/);
    assert.match(stdinPayload, /<boolean name="dev_server_https" value="true" \/>/);
  });
});

test('applyRuntimeHintsToApp rejects Android app binary paths before run-as', async () => {
  await withMockedAdb(async ({ device, argsLogPath }) => {
    await assert.rejects(
      applyRuntimeHintsToApp({
        device,
        appId: '/tmp/app-debug.apk',
        runtime: {
          platform: 'android',
          metroHost: '10.0.0.10',
          metroPort: 8081,
        },
      }),
      (error: unknown) =>
        assertInvalidArgsAppError(
          error,
          'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
        ),
    );

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8').catch(() => '');
    assert.equal(loggedArgs, '');
  });
});

test('applyRuntimeHintsToApp rejects bare Android app binary filenames before run-as', async () => {
  await withMockedAdb(async ({ device, argsLogPath }) => {
    await assert.rejects(
      applyRuntimeHintsToApp({
        device,
        appId: 'app-debug.apk',
        runtime: {
          platform: 'android',
          metroHost: '10.0.0.10',
          metroPort: 8081,
        },
      }),
      (error: unknown) =>
        assertInvalidArgsAppError(
          error,
          'Android runtime hints require an installed package name, not "app-debug.apk". Install or reinstall the app first, then relaunch by package.',
        ),
    );

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8').catch(() => '');
    assert.equal(loggedArgs, '');
  });
});

test('applyRuntimeHintsToApp distinguishes run-as denial from general write failures', async () => {
  await withMockedAdb(async ({ device }) => {
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE = '1';
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR =
      'run-as: package not debuggable: com.example.demo';
    try {
      await assert.rejects(
        applyRuntimeHintsToApp({
          device,
          appId: 'com.example.demo',
          runtime: {
            platform: 'android',
            metroHost: '10.0.0.10',
            metroPort: 8081,
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to access Android app sandbox for com.example.demo');
          assert.equal(
            error.details?.hint,
            'React Native runtime hints require adb run-as access to the app sandbox. Verify the app is debuggable and the selected package/device are correct.',
          );
          assert.equal(error.details?.exitCode, 1);
          assert.match(String(error.details?.stderr), /not debuggable/);
          return true;
        },
      );
    } finally {
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE;
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR;
    }
  });
});

test('applyRuntimeHintsToApp uses generic probe hint when probe fails without run-as denial output', async () => {
  await withMockedAdb(async ({ device }) => {
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE = '1';
    process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR = 'error: device not found';
    try {
      await assert.rejects(
        applyRuntimeHintsToApp({
          device,
          appId: 'com.example.demo',
          runtime: {
            platform: 'android',
            metroHost: '10.0.0.10',
            metroPort: 8081,
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to probe Android app sandbox for com.example.demo');
          assert.equal(
            error.details?.hint,
            'adb shell run-as probe failed. Check adb connectivity and that the device is reachable. Inspect stderr/details for more information.',
          );
          assert.equal(error.details?.exitCode, 1);
          assert.match(String(error.details?.stderr), /device not found/);
          return true;
        },
      );
    } finally {
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_EXIT_CODE;
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_ID_STDERR;
    }
  });
});

test('applyRuntimeHintsToApp preserves write failures after a successful run-as probe', async () => {
  await withMockedAdb(async ({ device }) => {
    process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE = '1';
    process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR =
      "sh: can't create shared_prefs/ReactNativeDevPrefs.xml: Permission denied";
    try {
      await assert.rejects(
        applyRuntimeHintsToApp({
          device,
          appId: 'com.example.demo',
          runtime: {
            platform: 'android',
            metroHost: '10.0.0.10',
            metroPort: 8081,
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to write Android runtime hints for com.example.demo');
          assert.equal(
            error.details?.hint,
            'adb run-as succeeded, but writing ReactNativeDevPrefs.xml failed. Inspect stderr/details for the failing shell command.',
          );
          assert.equal(error.details?.phase, 'write-runtime-hints');
          assert.equal(error.details?.exitCode, 1);
          assert.match(String(error.details?.stderr), /permission denied/i);
          return true;
        },
      );
    } finally {
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_EXIT_CODE;
      delete process.env.AGENT_DEVICE_TEST_RUN_AS_WRITE_STDERR;
    }
  });
});

test('clearRuntimeHintsFromApp removes managed Android runtime prefs but preserves unrelated entries', async () => {
  await withMockedAdb(async ({ device, readFilePath, stdinFilePath }) => {
    await fs.writeFile(
      readFilePath,
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        '  <string name="keep">value</string>',
        '  <string name="debug_http_host">10.0.0.10:8081</string>',
        '  <boolean name="dev_server_https" value="true" />',
        '</map>',
        '',
      ].join('\n'),
      'utf8',
    );

    await clearRuntimeHintsFromApp({
      device,
      appId: 'com.example.demo',
    });

    const stdinPayload = await fs.readFile(stdinFilePath, 'utf8');
    assert.match(stdinPayload, /<string name="keep">value<\/string>/);
    assert.doesNotMatch(stdinPayload, /debug_http_host/);
    assert.doesNotMatch(stdinPayload, /dev_server_https/);
  });
});

test('applyRuntimeHintsToApp writes iOS simulator React Native defaults', async () => {
  await withMockedXcrun(async ({ device, argsLogPath }) => {
    await applyRuntimeHintsToApp({
      device,
      appId: 'com.example.demo',
      runtime: {
        platform: 'ios',
        metroHost: '127.0.0.1',
        metroPort: 8081,
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults write com\.example\.demo RCT_jsLocation -string 127\.0\.0\.1:8081/,
    );
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults write com\.example\.demo RCT_packager_scheme -string http/,
    );
  });
});

test('clearRuntimeHintsFromApp deletes iOS simulator React Native defaults', async () => {
  await withMockedXcrun(async ({ device, argsLogPath }) => {
    await clearRuntimeHintsFromApp({
      device,
      appId: 'com.example.demo',
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults delete com\.example\.demo RCT_jsLocation/,
    );
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults delete com\.example\.demo RCT_packager_scheme/,
    );
  });
});
