import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Rect } from '@agent-device/kernel/snapshot';
import {
  intersectScreenshotRect,
  projectSnapshotRectToScreenshot,
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
