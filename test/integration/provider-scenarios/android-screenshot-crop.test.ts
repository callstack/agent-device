import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import { androidSettingsXml, createAndroidSettingsWorld } from './android-world.ts';
import { assertPngDimensions, assertRpcOk } from './assertions.ts';
import { withProviderScenarioResource } from './harness.ts';

function trackStaging() {
  return vi.spyOn(fs.promises, 'mkdtemp');
}

let staging: ReturnType<typeof trackStaging>;
beforeEach(() => {
  staging = trackStaging();
});
afterEach(async () => {
  const results = staging.mock.results.filter((_, index) =>
    path.basename(String(staging.mock.calls[index]?.[0])).startsWith('agent-device-crop-'),
  );
  staging.mockRestore();
  assert.ok(results.length > 0, 'the request must acquire crop staging');
  for (const result of results) {
    assert.equal(result.type, 'return');
    const directory = await result.value;
    assert.equal(fs.existsSync(directory), false, `crop staging remains: ${directory}`);
  }
});

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
  test(`ambiguous crop preserves ${destinationExists ? 'existing' : 'absent'} destination`, async () => {
    await withProviderScenarioResource(
      () =>
        createAndroidSettingsWorld({
          snapshotXml: () => androidSettingsXml('', { duplicateAppsRow: true }),
        }),
      async (world) => {
        await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
        const destination = path.join(world.tempRoot, 'crop.png');
        const sentinel = Buffer.from('existing destination');
        if (destinationExists) fs.writeFileSync(destination, sentinel);
        const response = await world.daemon.callCommand('screenshot', [destination], {
          screenshotCropOn: 'label="Apps"',
        });
        assert.equal(
          response.json?.error?.data?.details?.reason,
          SCREENSHOT_CROP_REASONS.targetAmbiguous,
        );
        assert.equal(response.json?.error?.data?.details?.matches, 2);
        if (destinationExists) assert.deepEqual(fs.readFileSync(destination), sentinel);
        else assert.equal(fs.existsSync(destination), false);
      },
    );
  });

  test(`successful crop publishes over ${destinationExists ? 'existing' : 'absent'} destination`, async () => {
    await withProviderScenarioResource(
      () =>
        createAndroidSettingsWorld({
          snapshotXml: () => androidSettingsXml('').replace('[24,124][152,178]', '[8,12][40,36]'),
        }),
      async (world) => {
        await world.daemon.client().apps.open({ app: 'settings', ...world.selection });
        const destination = path.join(world.tempRoot, 'crop.png');
        if (destinationExists) fs.writeFileSync(destination, 'existing destination');
        const response = await world.daemon.callCommand('screenshot', [destination], {
          screenshotCropOn: 'label="Apps"',
        });
        const result = assertRpcOk(response);
        assert.equal(result.path, destination);
        assert.equal(result.width, 32);
        assert.equal(result.height, 24);
        assertPngDimensions(destination, 32, 24);
      },
    );
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
