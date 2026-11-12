import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

for (const destinationExists of [true, false]) {
  test(`crop failure preserves ${destinationExists ? 'existing' : 'absent'} screenshot destination`, async () => {
    await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
      await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
      const destination = path.join(world.tempRoot, 'crop.png');
      const sentinel = Buffer.from('existing destination');
      if (destinationExists) fs.writeFileSync(destination, sentinel);
      const capturesBefore = world.adbCalls.filter((args) =>
        args.join(' ').includes('exec-out screencap -p'),
      ).length;

      const response = await world.daemon.callCommand('screenshot', [destination], {
        screenshotCropOn: 'label="No such crop target"',
      });

      assert.equal(
        response.json?.error?.data?.details?.reason,
        SCREENSHOT_CROP_REASONS.targetNotFound,
      );
      assert.equal(
        world.adbCalls.filter((args) => args.join(' ').includes('exec-out screencap -p')).length,
        capturesBefore + 1,
      );
      if (destinationExists) assert.deepEqual(fs.readFileSync(destination), sentinel);
      else assert.equal(fs.existsSync(destination), false);
    });
  });
}

for (const destinationExists of [true, false]) {
  test(`capture failure preserves ${destinationExists ? 'existing' : 'absent'} crop destination`, async () => {
    await withProviderScenarioResource(
      () =>
        createAndroidSettingsWorld({
          onAdbExec: (args) =>
            args.join(' ') === 'exec-out screencap -p'
              ? { stdout: '', stderr: 'capture failed', exitCode: 1 }
              : undefined,
        }),
      async (world) => {
        await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
        const destination = path.join(world.tempRoot, 'crop.png');
        const sentinel = Buffer.from('existing destination');
        if (destinationExists) fs.writeFileSync(destination, sentinel);
        const response = await world.daemon.callCommand('screenshot', [destination], {
          screenshotCropOn: 'label="Apps"',
        });
        assert.ok(response.json?.error);
        if (destinationExists) assert.deepEqual(fs.readFileSync(destination), sentinel);
        else assert.equal(fs.existsSync(destination), false);
      },
    );
  });
}
