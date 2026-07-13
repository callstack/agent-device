import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import { applyRuntimeHintsToApp, clearRuntimeHintsFromApp } from '../runtime-hints.ts';
import { applyDeviceDefaultMetroHost } from '../handlers/session-runtime.ts';
import { resolveRuntimeTransportHints } from '../../utils/runtime-transport.ts';
import type { DeviceInfo } from '../../kernel/device.ts';

const LEGACY_PREFS_PATH = 'shared_prefs/ReactNativeDevPrefs.xml';

function defaultPrefsPath(packageName: string): string {
  return `shared_prefs/${packageName}_preferences.xml`;
}

function prefsKey(prefsPath: string): string {
  return prefsPath.replaceAll('/', '_');
}

async function withMockedAdb(
  run: (ctx: {
    device: DeviceInfo;
    argsLogPath: string;
    seedPrefsFile: (prefsPath: string, xml: string) => Promise<void>;
    readWrittenPrefsFile: (prefsPath: string) => Promise<string | undefined>;
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-runtime-hints-android-'));
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
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
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
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousSeedDir = process.env.AGENT_DEVICE_TEST_SEED_DIR;
  const previousStdinDir = process.env.AGENT_DEVICE_TEST_STDIN_DIR;
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
    restoreEnv('AGENT_DEVICE_TEST_ARGS_FILE', previousArgsFile);
    restoreEnv('AGENT_DEVICE_TEST_SEED_DIR', previousSeedDir);
    restoreEnv('AGENT_DEVICE_TEST_STDIN_DIR', previousStdinDir);
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

test('applyRuntimeHintsToApp writes debug_http_host to the RN default-preferences file React Native actually reads', async () => {
  await withMockedAdb(async ({ device, argsLogPath, seedPrefsFile, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    await seedPrefsFile(
      defaultPrefsPath(packageName),
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        '  <string name="keep_default">default-value</string>',
        '</map>',
        '',
      ].join('\n'),
    );

    await applyRuntimeHintsToApp({
      device,
      appId: packageName,
      runtime: {
        platform: 'android',
        bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/com\.example\.demo_preferences\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/com\.example\.demo_preferences\.xml/,
    );

    const defaultPayload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(defaultPayload, 'expected a write to the default RN preferences file');
    assert.match(defaultPayload ?? '', /<string name="keep_default">default-value<\/string>/);
    assert.match(
      defaultPayload ?? '',
      /<string name="debug_http_host">10\.0\.0\.10:8082<\/string>/,
    );
    assert.match(defaultPayload ?? '', /<boolean name="dev_server_https" value="true" \/>/);
  });
});

test('applyRuntimeHintsToApp also writes the legacy ReactNativeDevPrefs.xml path for back-compat', async () => {
  await withMockedAdb(async ({ device, argsLogPath, seedPrefsFile, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    await seedPrefsFile(
      LEGACY_PREFS_PATH,
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        '  <string name="keep_legacy">legacy-value</string>',
        '</map>',
        '',
      ].join('\n'),
    );

    await applyRuntimeHintsToApp({
      device,
      appId: packageName,
      runtime: {
        platform: 'android',
        bundleUrl: 'https://10.0.0.10:8082/index.bundle?platform=android',
      },
    });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/com\.example\.demo_preferences\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo cat shared_prefs\/ReactNativeDevPrefs\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/com\.example\.demo_preferences\.xml/,
    );
    assert.match(
      loggedArgs,
      /shell run-as com\.example\.demo tee shared_prefs\/ReactNativeDevPrefs\.xml/,
    );

    const legacyPayload = await readWrittenPrefsFile(LEGACY_PREFS_PATH);
    assert.ok(legacyPayload, 'expected a write to the legacy ReactNativeDevPrefs.xml file');
    assert.match(legacyPayload ?? '', /<string name="keep_legacy">legacy-value<\/string>/);
    assert.match(legacyPayload ?? '', /<string name="debug_http_host">10\.0\.0\.10:8082<\/string>/);
    assert.match(legacyPayload ?? '', /<boolean name="dev_server_https" value="true" \/>/);
  });
});

test('port-only hint on an Android emulator defaults host to 10.0.2.2 and writes the dev-server pref', async () => {
  await withMockedAdb(async ({ device, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    const runtime = applyDeviceDefaultMetroHost({ platform: 'android', metroPort: 8084 }, device);
    assert.equal(runtime?.metroHost, '10.0.2.2');

    await applyRuntimeHintsToApp({ device, appId: packageName, runtime });

    const defaultPayload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(defaultPayload, 'expected a write to the default RN preferences file');
    assert.match(defaultPayload ?? '', /<string name="debug_http_host">10\.0\.2\.2:8084<\/string>/);
  });
});

test('port-only hint on a physical Android device stays ambiguous and writes nothing', async () => {
  await withMockedAdb(async ({ device, argsLogPath, readWrittenPrefsFile }) => {
    const physicalDevice: DeviceInfo = { ...device, id: 'R5CN30', kind: 'device' };
    const runtime = applyDeviceDefaultMetroHost(
      { platform: 'android', metroPort: 8084 },
      physicalDevice,
    );
    assert.equal(runtime?.metroHost, undefined);

    await applyRuntimeHintsToApp({ device: physicalDevice, appId: 'com.example.demo', runtime });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8').catch(() => '');
    assert.doesNotMatch(loggedArgs, /tee/);
    assert.equal(await readWrittenPrefsFile(defaultPrefsPath('com.example.demo')), undefined);
  });
});

test('port-only hint on an iOS simulator defaults host to 127.0.0.1', async () => {
  await withMockedXcrun(async ({ device, argsLogPath }) => {
    const runtime = applyDeviceDefaultMetroHost({ platform: 'ios', metroPort: 8084 }, device);
    assert.equal(runtime?.metroHost, '127.0.0.1');

    await applyRuntimeHintsToApp({ device, appId: 'com.example.demo', runtime });

    const loggedArgs = await fs.readFile(argsLogPath, 'utf8');
    assert.match(
      loggedArgs,
      /simctl spawn sim-1 defaults write com\.example\.demo RCT_jsLocation -string 127\.0\.0\.1:8084/,
    );
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
      "sh: can't create shared_prefs/com.example.demo_preferences.xml: Permission denied";
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
            'adb run-as succeeded, but writing React Native dev-server preferences failed. Inspect stderr/details for the failing shell command.',
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

test('clearRuntimeHintsFromApp removes managed Android runtime prefs from both files but preserves unrelated entries', async () => {
  await withMockedAdb(async ({ device, seedPrefsFile, readWrittenPrefsFile }) => {
    const packageName = 'com.example.demo';
    const seeded = (keepKey: string, keepValue: string): string =>
      [
        '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
        '<map>',
        `  <string name="${keepKey}">${keepValue}</string>`,
        '  <string name="debug_http_host">10.0.0.10:8081</string>',
        '  <boolean name="dev_server_https" value="true" />',
        '</map>',
        '',
      ].join('\n');
    await seedPrefsFile(defaultPrefsPath(packageName), seeded('keep_default', 'default-value'));
    await seedPrefsFile(LEGACY_PREFS_PATH, seeded('keep_legacy', 'legacy-value'));

    await clearRuntimeHintsFromApp({
      device,
      appId: packageName,
    });

    const defaultPayload = await readWrittenPrefsFile(defaultPrefsPath(packageName));
    assert.ok(defaultPayload, 'expected the default RN preferences file to be rewritten');
    assert.match(defaultPayload ?? '', /<string name="keep_default">default-value<\/string>/);
    assert.doesNotMatch(defaultPayload ?? '', /debug_http_host/);
    assert.doesNotMatch(defaultPayload ?? '', /dev_server_https/);

    const legacyPayload = await readWrittenPrefsFile(LEGACY_PREFS_PATH);
    assert.ok(legacyPayload, 'expected the legacy ReactNativeDevPrefs.xml file to be rewritten');
    assert.match(legacyPayload ?? '', /<string name="keep_legacy">legacy-value<\/string>/);
    assert.doesNotMatch(legacyPayload ?? '', /debug_http_host/);
    assert.doesNotMatch(legacyPayload ?? '', /dev_server_https/);
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
