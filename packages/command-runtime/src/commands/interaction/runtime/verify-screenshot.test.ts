import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PNG } from '@agent-device/capture-kit/png';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { createInteractionDevice, selectorSnapshot } from './__tests__/test-utils/index.ts';

test('coordinate verification keeps a changed tree digest when the frames match', async () => {
  const { writeFile } = await import('node:fs/promises');
  let tapped = false;
  const device = createInteractionDevice(selectorSnapshot(), {
    // The tree digest moves (a navigation replaced the content) while the
    // pixels at the settle instant still match.
    captureSnapshot: async () => {
      if (!tapped) return { snapshot: selectorSnapshot() };
      return {
        snapshot: makeSnapshotState([
          {
            index: 0,
            depth: 0,
            type: 'Application',
            rect: { x: 0, y: 0, width: 400, height: 800 },
            hittable: true,
          },
        ]),
      };
    },
    tap: async () => {
      tapped = true;
    },
    clock: { now: () => 0, sleep: async () => {} },
    captureVerifyScreenshot: async (outPath) => {
      const png = new PNG({ width: 4, height: 4 });
      png.data.fill(255);
      await writeFile(outPath, PNG.sync.write(png));
      return { ignoreTopHeightShare: 0.25 };
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 200, y: 25 },
    { verify: true },
  );

  // Any comparison verification made saw a change: the digest answer survives
  // identical frames, and the pixel-only answer stays in screenshotDiff.
  assert.equal(result.evidence?.changedFromBefore, true);
  assert.equal(result.evidence?.screenshotDiff?.changedFromBefore, false);
});

test.each([
  { x: 15, verify: true, frames: [], changed: false },
  { x: 200, verify: false, frames: [], changed: undefined },
  { x: 200, verify: true, frames: ['before', 'after'], changed: false },
  { x: 200, verify: true, frames: ['before', 'after'], changed: true },
])(
  'coordinate verification brackets dispatch only away from a touch target ($x, $verify, $changed)',
  async ({ x, verify, frames, changed }) => {
    const { writeFile } = await import('node:fs/promises');
    const captures: string[] = [];
    let tapped = false;
    const device = createInteractionDevice(selectorSnapshot(), {
      tap: async () => {
        tapped = true;
      },
      clock: { now: () => 0, sleep: async () => {} },
      captureVerifyScreenshot: async (outPath) => {
        captures.push(tapped ? 'after' : 'before');
        const png = new PNG({ width: 4, height: 4 });
        png.data.fill(255);
        if (tapped) png.data[0] = 0; // Status-bar-only change is ignored.
        if (tapped && changed) png.data[16] = 0;
        await writeFile(outPath, PNG.sync.write(png));
        return { ignoreTopHeightShare: 0.25 };
      },
    });
    const result = await device.interactions.press({ kind: 'point', x, y: 25 }, { verify });
    assert.deepEqual(captures, frames);
    assert.equal(result.evidence?.changedFromBefore, changed);
    assert.equal(
      result.evidence?.screenshotDiff?.changedFromBefore,
      frames.length ? changed : undefined,
    );
  },
);
