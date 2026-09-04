import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  intersectScreenshotRect,
  projectSnapshotRectToScreenshot,
  resolveScreenshotRectSpace,
  resolveSnapshotBounds,
  type ScreenshotRectSpace,
} from './snapshot-rect-projection.ts';

// Golden geometry table for `screenshot --crop-on`: the numbers are the live
// evidence baseline (iOS simulator 402/1206, Android 1080, macOS 586/1172),
// so a projection-law change that moves any accepted cell's crop box turns this
// red before the pixel-identity cross-check could ever notice.

type FixtureCase = {
  name: string;
  space: ScreenshotRectSpace;
  bounds: Rect | null;
  rect: Rect;
  image: { width: number; height: number };
  expectedProjection: Rect;
  expectedIntersection: Rect | null;
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'screenshot-crop-geometry.json',
);

test('the crop projection law agrees with every golden geometry case', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as FixtureCase[];
  assert.ok(cases.length > 0, 'geometry table must not be empty');
  const names = new Set(cases.map((fixture) => fixture.name));
  assert.equal(names.size, cases.length, 'geometry table case names must be unique');
  for (const fixture of cases) {
    const projected = projectSnapshotRectToScreenshot(
      fixture.space,
      fixture.bounds,
      fixture.rect,
      fixture.image.width,
      fixture.image.height,
    );
    assert.deepEqual(projected, fixture.expectedProjection, fixture.name);
    const intersection = intersectScreenshotRect(
      projected,
      fixture.image.width,
      fixture.image.height,
    );
    assert.deepEqual(intersection, fixture.expectedIntersection, fixture.name);
  }
});

test('resolveScreenshotRectSpace maps each accepted backend to its projection space and refuses the rest', () => {
  assert.equal(resolveScreenshotRectSpace('android'), 'device-pixels');
  assert.equal(resolveScreenshotRectSpace('xctest'), 'viewport-points');
  assert.equal(resolveScreenshotRectSpace('macos-helper'), 'viewport-points');
  for (const backend of [undefined, 'linux', 'web', 'harmonyos', 'vega']) {
    assert.throws(
      () => resolveScreenshotRectSpace(backend),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.details?.reason === SCREENSHOT_CROP_REASONS.targetNotAccepted,
    );
  }
});

test('resolveSnapshotBounds prefers the largest viewport root, else unions every positive rect excluding unlabeled images', () => {
  assert.deepEqual(
    resolveSnapshotBounds([
      { type: 'XCUIElementTypeImage', label: '', rect: { x: 0, y: 0, width: 50, height: 50 } },
      {
        type: 'XCUIElementTypeApplication',
        label: 'Settings',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
      {
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        rect: { x: 100, y: 100, width: 200, height: 50 },
      },
    ]),
    { x: 0, y: 0, width: 402, height: 874 },
  );
  assert.deepEqual(
    resolveSnapshotBounds([
      { type: 'XCUIElementTypeButton', label: 'A', rect: { x: 10, y: 20, width: 100, height: 40 } },
      {
        type: 'XCUIElementTypeButton',
        label: 'B',
        rect: { x: 300, y: 400, width: 60, height: 30 },
      },
      { type: 'XCUIElementTypeImage', label: '', rect: { x: 0, y: 0, width: 999, height: 999 } },
    ]),
    { x: 10, y: 20, width: 350, height: 410 },
  );
  assert.equal(
    resolveSnapshotBounds([
      { type: 'XCUIElementTypeButton', label: 'A', rect: { x: 0, y: 0, width: 0, height: 50 } },
    ]),
    null,
  );
});
