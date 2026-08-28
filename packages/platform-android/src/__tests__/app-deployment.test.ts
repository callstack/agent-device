import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAndroidInstallablePath } from '../app-deployment.ts';
import {
  inferAndroidAppName,
  resolveAndroidApp,
  withAndroidAppResolutionCacheInvalidated,
} from '../app-deployment-resolution.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { assertRejectsAppError } from './test-utils/app-error.ts';
import { withFakeAdb } from './test-utils/fake-adb.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.
// The fake exposes only `exec`, so installs take the legacy exec-shaped
// fallback and appear as `install ...` calls. bundletool is not adb: the .aab
// tests still shape it via PATH because production shells out to it directly.

test('inferAndroidAppName derives readable names from package ids', () => {
  assert.equal(inferAndroidAppName('com.android.settings'), 'Settings');
  assert.equal(inferAndroidAppName('com.google.android.apps.maps'), 'Maps');
  assert.equal(inferAndroidAppName('org.mozilla.firefox'), 'Firefox');
  assert.equal(inferAndroidAppName('com.facebook.katana'), 'Katana');
  assert.equal(inferAndroidAppName('single'), 'Single');
  assert.equal(inferAndroidAppName('com.android.app.services'), 'Services');
});

test('installAndroidInstallablePath installs .apk via adb install -r', async () => {
  const apkPath = path.join(os.tmpdir(), `agent-device-test-${Date.now()}.apk`);
  await fs.writeFile(apkPath, 'placeholder', 'utf8');
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await installAndroidInstallablePath(device, apkPath);
      const flat = calls.map((args) => args.join(' '));
      assert.ok(
        flat.some((call) => /^install -r .*agent-device-test-.*\.apk$/.test(call)),
        flat.join('; '),
      );
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

test('installAndroidInstallablePath installs .aab via bundletool build-apks + install-apks', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-install-aab-');
  const bundletoolPath = path.join(tmpDir, 'bundletool');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');
  await fs.writeFile(
    bundletoolPath,
    [
      '#!/bin/sh',
      String.raw`printf "bundletool %s\n" "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"`,
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

  try {
    await withFakeAdb(
      () => undefined,
      async ({ calls, device }) => {
        await installAndroidInstallablePath(device, aabPath);
        const logged = await fs.readFile(argsLogPath, 'utf8');
        assert.match(logged, /bundletool build-apks .*--bundle .*Sample\.aab .*--mode universal/);
        assert.match(logged, /bundletool install-apks .*--device-id emulator-5554/);
        const flat = calls.map((args) => args.join(' '));
        assert.equal(
          flat.some((call) => call.startsWith('install ')),
          false,
          flat.join('; '),
        );
      },
    );
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

test('installAndroidInstallablePath .aab reports missing bundletool tooling', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-install-aab-missing-tool-');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');

  const previousPath = process.env.PATH;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  // Narrow PATH to the (binary-free) temp dir so bundletool is deterministically
  // absent even on hosts that have it installed; adb stays in-process.
  process.env.PATH = tmpDir;
  delete process.env.AGENT_DEVICE_BUNDLETOOL_JAR;

  try {
    await withFakeAdb(
      () => undefined,
      async ({ device }) => {
        await assertRejectsAppError(() => installAndroidInstallablePath(device, aabPath), {
          code: 'TOOL_MISSING',
          message: /bundletool/i,
        });
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

test('installAndroidInstallablePath .aab rejects relative AGENT_DEVICE_BUNDLETOOL_JAR overrides', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-install-aab-relative-jar-');
  const aabPath = path.join(tmpDir, 'Sample.aab');
  await fs.writeFile(aabPath, 'placeholder', 'utf8');

  const previousPath = process.env.PATH;
  const previousBundletoolJar = process.env.AGENT_DEVICE_BUNDLETOOL_JAR;
  // Narrow PATH so the relative-jar override is what resolution actually hits.
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_BUNDLETOOL_JAR = './bundletool-all.jar';

  try {
    await withFakeAdb(
      () => undefined,
      async ({ device }) => {
        await assert.rejects(() => installAndroidInstallablePath(device, aabPath), {
          code: 'INVALID_ARGS',
        });
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

test('resolveAndroidApp does not treat file paths as package names', async () => {
  await withFakeAdb(
    (args) =>
      args[0] === 'shell' && args[1] === 'pm' && args[2] === 'list'
        ? 'package:com.example.demo'
        : undefined,
    async ({ device }) => {
      await assertRejectsAppError(() => resolveAndroidApp(device, '/path/to/app-debug.apk'), {
        code: 'APP_NOT_INSTALLED',
      });
    },
  );
});

test('resolveAndroidApp caches display-name package matches but bypasses exact package ids', async () => {
  await withFakeAdb(
    (args) => {
      if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'list' && args[3] === 'packages') {
        return 'package:com.example.cachemaps';
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      const first = await resolveAndroidApp(device, 'cachemaps');
      const second = await resolveAndroidApp(device, 'cachemaps');
      const exact = await resolveAndroidApp(device, 'com.example.cachemaps');

      assert.deepEqual(first, { type: 'package', value: 'com.example.cachemaps' });
      assert.deepEqual(second, first);
      assert.deepEqual(exact, { type: 'package', value: 'com.example.cachemaps' });

      const listCalls = calls.filter((args) => args.join(' ') === 'shell pm list packages');
      assert.equal(listCalls.length, 1);
    },
  );
});

test('installAndroidInstallablePath invalidates cached display-name package matches', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-cache-apk-');
  const apkPath = path.join(tmpDir, 'App.apk');
  try {
    await fs.writeFile(apkPath, '', 'utf8');
    let installed = false;
    await withFakeAdb(
      (args) => {
        if (
          args[0] === 'shell' &&
          args[1] === 'pm' &&
          args[2] === 'list' &&
          args[3] === 'packages'
        ) {
          return installed
            ? 'package:com.example.installedcachemaps'
            : 'package:com.example.cachemaps';
        }
        if (args[0] === 'install' && args[1] === '-r') {
          installed = true;
          return undefined;
        }
        return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
      },
      async ({ device }) => {
        const before = await resolveAndroidApp(device, 'cachemaps');
        await installAndroidInstallablePath(device, apkPath);
        const after = await resolveAndroidApp(device, 'cachemaps');

        assert.deepEqual(before, { type: 'package', value: 'com.example.cachemaps' });
        assert.deepEqual(after, { type: 'package', value: 'com.example.installedcachemaps' });
      },
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Android deployment cache bracket clears fuzzy targets before and after a partial failure', async () => {
  let packages = ['com.example.stalemaps'];
  await withFakeAdb(
    (args) => {
      if (args.join(' ') === 'shell pm list packages') {
        return packages.map((packageName) => `package:${packageName}`).join('\n');
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      const before = await resolveAndroidApp(device, 'maps');
      packages = ['com.example.currentmaps'];

      await assert.rejects(
        async () =>
          await withAndroidAppResolutionCacheInvalidated(device, async () => {
            assert.deepEqual(await resolveAndroidApp(device, 'maps'), {
              type: 'package',
              value: 'com.example.currentmaps',
            });
            packages = ['com.example.replacementmaps'];
            throw new Error('replacement materialization failed');
          }),
        /replacement materialization failed/,
      );

      const after = await resolveAndroidApp(device, 'maps');
      assert.deepEqual(before, { type: 'package', value: 'com.example.stalemaps' });
      assert.deepEqual(after, { type: 'package', value: 'com.example.replacementmaps' });
    },
    {
      device: {
        platform: 'android',
        id: 'emulator-cache-bracket',
        name: 'Pixel',
        kind: 'emulator',
        booted: true,
      },
    },
  );
});
