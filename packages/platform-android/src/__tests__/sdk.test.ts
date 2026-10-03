import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureAndroidSdkPathConfigured, resolveAndroidSdkRoots } from '../sdk.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

async function withTempSdkLayout(
  run: (ctx: { env: NodeJS.ProcessEnv; sdkRoot: string }) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtempForTest('agent-device-android-sdk-');
  const sdkRoot = path.join(tmpDir, 'Android', 'Sdk');
  const cmdlineToolsLatestDir = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin');
  const cmdlineToolsToolsDir = path.join(sdkRoot, 'cmdline-tools', 'tools', 'bin');
  const emulatorDir = path.join(sdkRoot, 'emulator');
  const platformToolsDir = path.join(sdkRoot, 'platform-tools');

  await fs.mkdir(cmdlineToolsLatestDir, { recursive: true });
  await fs.mkdir(cmdlineToolsToolsDir, { recursive: true });
  await fs.mkdir(emulatorDir, { recursive: true });
  await fs.mkdir(platformToolsDir, { recursive: true });

  for (const filePath of [
    path.join(platformToolsDir, 'adb'),
    path.join(emulatorDir, 'emulator'),
    path.join(cmdlineToolsLatestDir, 'sdkmanager'),
    path.join(cmdlineToolsToolsDir, 'avdmanager'),
  ]) {
    await fs.writeFile(filePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(filePath, 0o755);
  }

  const env = {
    HOME: tmpDir,
    PATH: '',
  } satisfies NodeJS.ProcessEnv;

  try {
    await run({ env, sdkRoot });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('resolveAndroidSdkRoots prefers configured roots before HOME default', () => {
  const roots = resolveAndroidSdkRoots({
    HOME: '/tmp/home',
    ANDROID_HOME: '/tmp/android-home',
    ANDROID_SDK_ROOT: '/tmp/android-sdk-root',
  });
  assert.deepEqual(roots, [
    '/tmp/android-sdk-root',
    '/tmp/android-home',
    path.join('/tmp/home', 'Android', 'Sdk'),
  ]);
});

test('ensureAndroidSdkPathConfigured mirrors a single configured SDK root into PATH and ANDROID_HOME', async () => {
  await withTempSdkLayout(async ({ env, sdkRoot }) => {
    env.ANDROID_SDK_ROOT = sdkRoot;

    await ensureAndroidSdkPathConfigured(env, {
      isExecutable: async (filePath) => {
        try {
          await fs.access(filePath);
          return true;
        } catch {
          return false;
        }
      },
    });

    assert.equal(env.ANDROID_HOME, sdkRoot);
    assert.equal(env.ANDROID_SDK_ROOT, sdkRoot);
    const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    assert.deepEqual(pathEntries.slice(0, 4), [
      path.join(sdkRoot, 'emulator'),
      path.join(sdkRoot, 'platform-tools'),
      path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin'),
      path.join(sdkRoot, 'cmdline-tools', 'tools', 'bin'),
    ]);
  });
});
