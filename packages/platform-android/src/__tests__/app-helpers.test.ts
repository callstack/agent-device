import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';
import { createDeviceAdbExecutor } from '../adb-executor.ts';
import { listAndroidAppsWithAdb } from '../app-helpers.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

async function withMockedAdbScript(script: string, run: () => Promise<void>): Promise<void> {
  const tmpDir = await mkdtempForTest('agent-device-android-app-helpers-');
  const adbPath = path.join(tmpDir, 'adb');
  await fs.writeFile(adbPath, script, 'utf8');
  await fs.chmod(adbPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  try {
    await run();
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('listAndroidAppsWithAdb uses an injected executor', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('query-activities')) {
      return {
        exitCode: 0,
        stdout: 'com.example.alpha/.MainActivity\ncom.example.beta/.MainActivity\n',
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: 'package:com.example.beta\n',
      stderr: '',
    };
  };

  const apps = await listAndroidAppsWithAdb(adb, { filter: 'user-installed', target: 'mobile' });

  assert.deepEqual(apps, [{ package: 'com.example.beta', name: 'Beta' }]);
  assert.deepEqual(calls, [
    [
      'shell',
      'cmd',
      'package',
      'query-activities',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
    ],
    ['shell', 'pm', 'list', 'packages', '-3'],
  ]);
});

test('Android app helpers work with a local ADB provider', async () => {
  await withMockedAdbScript(
    [
      '#!/bin/sh',
      'if [ "$1" = "-s" ]; then',
      '  shift',
      '  shift',
      'fi',
      'if [ "$1" = "shell" ] && [ "$3" = "window" ]; then',
      '  echo "mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$3" = "package" ]; then',
      '  echo "com.example.app/.MainActivity"',
      '  exit 0',
      'fi',
      'if [ "$1" = "shell" ] && [ "$2" = "pm" ] && [ "$3" = "list" ] && [ "$4" = "packages" ] && [ "$5" = "-3" ]; then',
      '  echo "package:com.example.app"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    async () => {
      const adb = createDeviceAdbExecutor({
        platform: 'android',
        id: 'emulator-5554',
        name: 'Pixel',
        kind: 'emulator',
        booted: true,
      });

      const apps = await listAndroidAppsWithAdb(adb, { target: 'mobile' });

      assert.deepEqual(apps, [{ package: 'com.example.app', name: 'Example' }]);
    },
  );
});
