import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

test('Provider-backed Android reinstall keeps the installed app when the archive has no installable', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const payloadDir = path.join(world.tempRoot, 'no-installable-payload');
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.writeFileSync(path.join(payloadDir, 'README.txt'), 'not an apk');
    const archivePath = path.join(world.tempRoot, 'NoInstallable.zip');
    const zipped = await runCmd('zip', ['-q', archivePath, 'README.txt'], {
      cwd: payloadDir,
      allowFailure: true,
    });
    assert.equal(zipped.exitCode, 0, zipped.stderr);

    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
    const callsBefore = world.adbCalls.length;
    await assert.rejects(
      world.daemon
        .client()
        .apps.reinstall({ app: 'com.example.demo', appPath: archivePath, ...world.selection }),
      {
        code: 'INVALID_ARGS',
        message: /Expected Android installable \(\.apk or \.aab\) source/,
      },
    );

    const reinstallCalls = world.adbCalls.slice(callsBefore);
    assert.equal(
      reinstallCalls.some((call) => call[0] === 'uninstall'),
      false,
      'a replacement that cannot be materialized must not reach adb uninstall',
    );
    assert.equal(world.apkInstallCalls.length, 0);
    assert.equal(world.bundleInstallCalls.length, 0);
  });
});
