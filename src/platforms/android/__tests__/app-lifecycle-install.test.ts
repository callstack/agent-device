import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inferAndroidAppName,
  installAndroidApp,
  installAndroidInstallablePath,
  parseAndroidLaunchComponent,
  resolveAndroidApp,
} from '../app-lifecycle.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withScriptedAdb } from '../../../__tests__/test-utils/mocked-binaries.ts';

test('parseAndroidLaunchComponent extracts final resolved component', () => {
  const stdout = [
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
    'com.boatsgroup.boattrader/com.boatsgroup.boattrader.MainActivity',
  ].join('\n');
  assert.equal(
    parseAndroidLaunchComponent(stdout),
    'com.boatsgroup.boattrader/com.boatsgroup.boattrader.MainActivity',
  );
});

test('parseAndroidLaunchComponent returns null when no component is present', () => {
  const stdout = 'No activity found';
  assert.equal(parseAndroidLaunchComponent(stdout), null);
});

test('inferAndroidAppName derives readable names from package ids', () => {
  assert.equal(inferAndroidAppName('com.android.settings'), 'Settings');
  assert.equal(inferAndroidAppName('com.google.android.apps.maps'), 'Maps');
  assert.equal(inferAndroidAppName('org.mozilla.firefox'), 'Firefox');
  assert.equal(inferAndroidAppName('com.facebook.katana'), 'Katana');
  assert.equal(inferAndroidAppName('single'), 'Single');
  assert.equal(inferAndroidAppName('com.android.app.services'), 'Services');
});

test('installAndroidApp installs .apk via adb install -r', async () => {
  const apkPath = path.join(os.tmpdir(), `agent-device-test-${Date.now()}.apk`);
  await fs.writeFile(apkPath, 'placeholder', 'utf8');
  await withScriptedAdb(
    'agent-device-android-install-apk-',
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    async ({ argsLogPath, device }) => {
      await installAndroidApp(device, apkPath);
      const logged = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').join(' ');
      assert.match(logged, /install -r .*agent-device-test-.*\.apk/);
    },
  );
  await fs.rm(apkPath, { force: true });
});

test('installAndroidInstallablePath uses provider install capability when available', async () => {
  const apkPath = path.join(os.tmpdir(), `agent-device-provider-install-${Date.now()}.apk`);
  await fs.writeFile(apkPath, 'placeholder', 'utf8');
  const installCalls: Array<{ source: string; replace: boolean | undefined }> = [];
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await withAndroidAdbProvider(
      {
        exec: async (args) => {
          throw new Error(`unexpected adb exec: ${args.join(' ')}`);
        },
        install: async (source, options) => {
          installCalls.push({ source: String(source), replace: options?.replace });
          return { stdout: 'Success', stderr: '', exitCode: 0 };
        },
      },
      { serial: 'emulator-5554' },
      async () => await installAndroidInstallablePath(device, apkPath),
    );
  } finally {
    await fs.rm(apkPath, { force: true });
  }

  assert.deepEqual(installCalls, [{ source: apkPath, replace: true }]);
});

test('installAndroidApp resolves packageName and launchTarget from nested archive artifacts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-install-archive-'));
  const adbPath = path.join(tmpDir, 'adb');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const installMarkerPath = path.join(tmpDir, 'installed.marker');
  const archivePath = path.join(tmpDir, 'Sample.zip');
  const manifestDir = path.join(tmpDir, 'manifest');
  const nestedDir = path.join(tmpDir, 'nested');
  await fs.mkdir(manifestDir);
  await fs.mkdir(nestedDir);
  await fs.writeFile(
    path.join(manifestDir, 'AndroidManifest.xml'),
    '<manifest package="com.example.archive" />',
    'utf8',
  );
  execFileSync('zip', ['-qr', path.join(nestedDir, 'Sample.apk'), 'AndroidManifest.xml'], {
    cwd: manifestDir,
  });
  execFileSync('zip', ['-qr', archivePath, 'nested'], { cwd: tmpDir });

  await fs.writeFile(
    adbPath,
    [
      '#!/bin/sh',
      'printf "adb %s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ]; then',
      `  if [ -f "${installMarkerPath}" ]; then`,
      '    echo "package:com.example.archive"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "install" ] && [ "$2" = "-r" ]; then',
      `  : > "${installMarkerPath}"`,
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);
  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    const result = await installAndroidApp(device, archivePath);
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.equal(result.archivePath, archivePath);
    assert.equal(result.packageName, 'com.example.archive');
    assert.equal(result.appName, 'Archive');
    assert.equal(result.launchTarget, 'com.example.archive');
    assert.equal(result.installablePath.endsWith('/nested/Sample.apk'), true);
    assert.match(logged, /adb -s emulator-5554 install -r .*nested\/Sample\.apk/);
    assert.doesNotMatch(logged, /adb -s emulator-5554 shell pm list packages/);
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

test('installAndroidApp installs .aab via bundletool build-apks + install-apks', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-install-aab-'));
  const adbPath = path.join(tmpDir, 'adb');
  const bundletoolPath = path.join(tmpDir, 'bundletool');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(
    adbPath,
    '#!/bin/sh\nprintf "adb %s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"\nexit 0\n',
    'utf8',
  );
  await fs.chmod(adbPath, 0o755);
  await fs.writeFile(
    bundletoolPath,
    [
      '#!/bin/sh',
      'printf "bundletool %s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "build-apks" ]; then',
      '  out=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--output" ]; then',
      '      out="$2"',
      '      shift 2',
      '      continue',
      '    fi',
      '    shift',
      '  done',
      '  # PATH is narrowed to the fake tools dir; test output paths are absolute.',
      '  /bin/mkdir -p "${out%/*}"',
      '  printf "apks" > "$out"',
      '  exit 0',
      'fi',
      'if [ "$1" = "install-apks" ]; then',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bundletoolPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;
  delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await installAndroidApp(device, aabPath);
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /bundletool build-apks .*--bundle .*Sample\.aab .*--mode universal/);
    assert.match(logged, /bundletool install-apks .*--device-id emulator-5554/);
    assert.doesNotMatch(logged, /adb .* install -r/);
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    if (previousBundletoolJar === undefined) {
      delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
    } else {
      process.env.AGENT_DEVICE_BUNDLETOOL_JAR = previousBundletoolJar;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installAndroidApp .aab reports missing bundletool tooling', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-install-aab-missing-tool-'),
  );
  const adbPath = path.join(tmpDir, 'adb');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(adbPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  process.env.PATH = tmpDir;
  delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await assert.rejects(
      () => installAndroidApp(device, aabPath),
      (error: unknown) => {
        assert.equal(error instanceof AppError, true);
        assert.equal((error as AppError).code, 'TOOL_MISSING');
        assert.match((error as AppError).message, /bundletool/i);
        return true;
      },
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousBundletoolJar === undefined) {
      delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
    } else {
      process.env.AGENT_DEVICE_BUNDLETOOL_JAR = previousBundletoolJar;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('installAndroidApp .aab rejects relative AGENT_DEVICE_BUNDLETOOL_JAR overrides', async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'agent-device-android-install-aab-relative-jar-'),
  );
  const adbPath = path.join(tmpDir, 'adb');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(adbPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_BUNDLETOOL_JAR = './bundletool-all.jar';

  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  try {
    await assert.rejects(() => installAndroidApp(device, aabPath), { code: 'INVALID_ARGS' });
  } finally {
    process.env.PATH = previousPath;
    if (previousBundletoolJar === undefined) {
      delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
    } else {
      process.env.AGENT_DEVICE_BUNDLETOOL_JAR = previousBundletoolJar;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveAndroidApp does not treat file paths as package names', async () => {
  await withScriptedAdb(
    'agent-device-android-resolve-path-',
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then shift; shift; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ]; then',
      '  echo "package:com.example.demo"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async ({ device }) => {
      await assert.rejects(
        resolveAndroidApp(device, '/path/to/app-debug.apk'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'APP_NOT_INSTALLED');
          return true;
        },
      );
    },
  );
});

test('resolveAndroidApp caches display-name package matches but bypasses exact package ids', async () => {
  await withScriptedAdb(
    'agent-device-android-resolve-cache-',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then shift; shift; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ]; then',
      '  echo "package:com.example.cachemaps"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    async ({ argsLogPath, device }) => {
      const first = await resolveAndroidApp(device, 'cachemaps');
      const second = await resolveAndroidApp(device, 'cachemaps');
      const exact = await resolveAndroidApp(device, 'com.example.cachemaps');

      assert.deepEqual(first, { type: 'package', value: 'com.example.cachemaps' });
      assert.deepEqual(second, first);
      assert.deepEqual(exact, { type: 'package', value: 'com.example.cachemaps' });

      const logged = await fs.readFile(argsLogPath, 'utf8');
      assert.equal((logged.match(/pm list packages/g) ?? []).length, 1);
    },
  );
});

test('installAndroidInstallablePath invalidates cached display-name package matches', async () => {
  await withScriptedAdb(
    'agent-device-android-install-cache-',
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"',
      'if [ "$1" = "-s" ]; then shift; shift; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ]; then',
      '  if [ -f "$AGENT_DEVICE_TEST_INSTALL_MARKER" ]; then',
      '    echo "package:com.example.installedcachemaps"',
      '  else',
      '    echo "package:com.example.cachemaps"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$1" = "install" ] && [ "$2" = "-r" ]; then',
      '  : > "$AGENT_DEVICE_TEST_INSTALL_MARKER"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    async ({ device }) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-android-cache-apk-'));
      const apkPath = path.join(tmpDir, 'App.apk');
      const previousMarker = process.env.AGENT_DEVICE_TEST_INSTALL_MARKER;
      process.env.AGENT_DEVICE_TEST_INSTALL_MARKER = path.join(tmpDir, 'installed.marker');
      try {
        await fs.writeFile(apkPath, '', 'utf8');
        const before = await resolveAndroidApp(device, 'cachemaps');
        await installAndroidInstallablePath(device, apkPath);
        const after = await resolveAndroidApp(device, 'cachemaps');

        assert.deepEqual(before, { type: 'package', value: 'com.example.cachemaps' });
        assert.deepEqual(after, { type: 'package', value: 'com.example.installedcachemaps' });
      } finally {
        if (previousMarker === undefined) {
          delete process.env.AGENT_DEVICE_TEST_INSTALL_MARKER;
        } else {
          process.env.AGENT_DEVICE_TEST_INSTALL_MARKER = previousMarker;
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

test('parseAndroidLaunchComponent handles multi-entry resolve output', () => {
  // Some devices return extra metadata lines before the component
  const stdout = [
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
    'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
  ].join('\n');
  assert.equal(
    parseAndroidLaunchComponent(stdout),
    'com.microsoft.office.outlook/com.microsoft.office.outlook.ui.miit.MiitLauncherActivity',
  );
});
